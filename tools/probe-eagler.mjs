// EaglerXServer probe: MOTD status query, and optionally the full v5 login.
// Accepts wss://host[:port] (TLS) and ws://host[:port] (plain), or a bare host
// for wss on 443.
//
//   node tools/probe-eagler.mjs wss://playmc.jonurres.best#777            # CLIENT_VERSION only
//   node tools/probe-eagler.mjs wss://playmc.jonurres.best#777 motd       # + Accept: motd reply
//   node tools/probe-eagler.mjs ws://127.0.0.1:25565#777 login TestProbe  # full login
//
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';

function wsFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
}

const str8 = (s) => {
    const b = Buffer.from(s, 'utf8').subarray(0, 255);
    return Buffer.concat([Buffer.from([b.length]), b]);
};

function clientVersion(mcProtocol, name) {
    return Buffer.concat([
        Buffer.from([0x01, 0x02, 0x00, 0x01, 0x00, 0x05, 0x00, 0x01]),
        Buffer.from([(mcProtocol >> 8) & 0xff, mcProtocol & 0xff]),
        str8('Horizon'), str8('0.1.0-probe'), Buffer.from([0x00]), str8(name),
    ]);
}

function requestLogin(name) {
    // 0x04, name, server "default", no password, no cookie, no capabilities.
    return Buffer.concat([
        Buffer.from([0x04]), str8(name), str8('default'), Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
}

function target(spec) {
    const text = spec.includes('://') ? spec : `wss://${spec}`;
    const url = new URL(text);
    const secure = url.protocol === 'wss:';
    const port = Number(url.port || (secure ? 443 : 80));
    const host = url.hostname;
    const hostHeader = url.port ? `${host}:${url.port}` : host;
    return { secure, host, port, hostHeader };
}

function probe(spec, mcProtocol, mode, name) {
    return new Promise((resolve) => {
        const { secure, host, port, hostHeader } = target(spec);
        const key = crypto.randomBytes(16).toString('base64');
        const started = Date.now();
        const result = { spec, mcProtocol, mode, log: [] };
        const log = (m) => result.log.push(`${Date.now() - started}ms ${m}`);
        const finish = () => {
            if (result.done) return;
            result.done = true;
            resolve(result);
        };
        let sock;
        const onConnect = () => {
            sock.write(
                `GET / HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                `Origin: ${secure ? 'https' : 'http'}://${hostHeader}\r\n` +
                `User-Agent: Mozilla/5.0 HorizonProbe\r\n\r\n`,
            );
        };
        try {
            sock = secure
                ? tls.connect({ host, port, servername: host, timeout: 12000 }, onConnect)
                : net.connect({ host, port, timeout: 12000 }, onConnect);
        } catch (e) {
            log(`connect error ${e.message}`);
            return finish();
        }
        let handshook = false;
        let buf = Buffer.alloc(0);
        const send = (data) => sock.write(wsFrame(0x2, data));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (!handshook) {
                const end = buf.indexOf('\r\n\r\n');
                if (end === -1) return;
                const status = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
                log(`http ${status}`);
                buf = buf.subarray(end + 4);
                if (!/ 101 /.test(status)) {
                    log('upgrade refused');
                    sock.destroy();
                    return finish();
                }
                handshook = true;
                if (mode === 'motd') {
                    // A status query is a text frame on the fresh socket, before any login.
                    sock.write(wsFrame(0x1, Buffer.from('Accept: motd')));
                    log('-> Accept: motd');
                } else {
                    send(clientVersion(mcProtocol, name));
                }
            }
            while (buf.length >= 2) {
                const opcode = buf[0] & 0x0f;
                let len = buf[1] & 0x7f;
                let offset = 2;
                if (len === 126) {
                    if (buf.length < 4) return;
                    len = buf.readUInt16BE(2);
                    offset = 4;
                } else if (len === 127) {
                    if (buf.length < 10) return;
                    len = Number(buf.readBigUInt64BE(2));
                    offset = 10;
                }
                if (buf.length < offset + len) return;
                const payload = buf.subarray(offset, offset + len);
                buf = buf.subarray(offset + len);
                const kind = payload[0];
                if (opcode === 0x1) {
                    log(`text ${payload.toString('utf8').slice(0, 500)}`);
                    if (mode === 'motd') {
                        sock.destroy();
                        return finish();
                    }
                    continue;
                }
                log(`frame op=${opcode} len=${len} id=0x${kind.toString(16)} hex=${payload.subarray(0, 48).toString('hex')}`);
                if (kind === 0x02) {
                    log('=> SERVER_VERSION (accepted mc=' + mcProtocol + ')');
                    if (mode === 'login') {
                        send(requestLogin(name));
                        log('-> REQUEST_LOGIN');
                    } else {
                        sock.destroy();
                        return finish();
                    }
                } else if (kind === 0x03) {
                    // VERSION_MISMATCH: eagler count+list, mc count+list, u16 min, u16 max, message
                    let i = 1;
                    const ea = payload[i++];
                    i += ea * 2;
                    const mc = payload[i++];
                    i += mc * 2;
                    const min = payload.readUInt16BE(i);
                    const max = payload.readUInt16BE(i + 2);
                    i += 4;
                    const n = payload[i++];
                    log(`=> VERSION_MISMATCH: mc ${min}..${max} msg=${payload.subarray(i + 1, i + 1 + n).toString('utf8')}`);
                    sock.destroy();
                    return finish();
                } else if (kind === 0x05) {
                    const n = payload[1];
                    const player = payload.subarray(2, 2 + n).toString('utf8');
                    const uuid = payload.subarray(2 + n, 2 + n + 16).toString('hex');
                    log(`=> ALLOW_LOGIN player=${player} uuid=${uuid}`);
                    if (mode === 'login') {
                        send(Buffer.from([0x08]));
                        log('-> FINISH_LOGIN');
                    }
                } else if (kind === 0x06) {
                    const n = payload.readUInt16BE(1);
                    log(`=> DENY_LOGIN ${payload.subarray(3, 3 + n).toString('utf8')}`);
                    sock.destroy();
                    return finish();
                } else if (kind === 0x09) {
                    log('=> FINISH_LOGIN ack: backend login complete');
                    sock.destroy();
                    return finish();
                } else if (kind === 0xff) {
                    log(`=> ERROR code=${payload[1]} rest=${payload.subarray(2).toString('utf8')}`);
                    sock.destroy();
                    return finish();
                }
            }
        });
        sock.on('timeout', () => { log('timeout'); sock.destroy(); finish(); });
        sock.on('error', (e) => { log(`error ${e.message}`); finish(); });
        sock.on('close', () => { log('closed'); finish(); });
        setTimeout(() => { log('overall timeout'); sock.destroy(); finish(); }, 25000);
    });
}

const spec = process.argv[2];
const mode = process.argv[3] || 'version';
const name = process.argv[4] || 'HorizonProbe';
if (!spec) {
    console.error('usage: node tools/probe-eagler.mjs <ws://host[:port]|wss://host[:port]>#<mcProtocol> [version|motd|login] [name]');
    process.exit(1);
}
const [hostSpec, proto] = spec.split('#');
const r = await probe(hostSpec, Number(proto || 777), mode, name);
console.log(`\n=== ${r.spec} (MC ${r.mcProtocol}, mode ${r.mode}) ===`);
for (const line of r.log) console.log(`  ${line}`);
