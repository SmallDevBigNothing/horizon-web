# Joining a 1.12.2 server with Horizon (protocol 777)

## Symptom

The Eagler handshake succeeds, then the server disconnects with:

```
ERROR code=8 {"translate":"Outdated server! I'm still on 1.12.2"}
```

This is the **Paper 1.12.2 backend** rejecting Minecraft protocol 777. The
client is fine; the server has no translator for 777.

## Why the translator cannot live on Paper 1.12.2

- ViaVersion 5.12.2 (the version that knows protocol 777 / MC 26.3) needs
  **Java 17+**. Paper 1.12.2 runs **Java 8**.
- ViaVersion 4.x runs on Java 8 but does not know 777.
- Velocity 3.5.1 is capped at 26.2 (776); it refuses 777.
- Velocity **4.3.1** on **Java 25** is the first proxy that accepts 777.

So translation must happen in a modern proxy in front of the backend.

## Target layout

```
Horizon (browser, wss)
        │  Minecraft 777
        ▼
Velocity 4.3.1 (Java 25)
  EaglerXServer 1.1.1     WebSocket + Eagler login (accepts 777)
  ViaVersion 5.12.2       translates 777 → 340
        │  Minecraft 340 (legacy forwarding)
        ▼
Paper 1.12.2 (Java 8) on 127.0.0.1:25566
```

## Server changes (owner of playmc)

1. Install **Java 25** for Velocity (<https://adoptium.net/>). Keep **Java 8**
   for Paper 1.12.2.
2. Velocity 4.3.1 (<https://papermc.io/downloads/velocity>) in its own folder;
   put these in `plugins/`:
   - <https://github.com/lax1dude/eaglerxserver/releases/download/v1.1.1/EaglerXServer.jar>
   - <https://github.com/ViaVersion/ViaVersion/releases/download/5.12.2/ViaVersion-5.12.2.jar>
3. `velocity.toml`:
   - `bind = "0.0.0.0:25565"`
   - `online-mode = false`
   - `force-key-authentication = false`
   - `player-info-forwarding-mode = "legacy"`
   - `[servers] lobby = "127.0.0.1:25566"`, `try = ["lobby"]`
   - remove the sample `factions`/`minigames` servers and forced hosts.
4. Paper 1.12.2:
   - bind `127.0.0.1:25566`, `online-mode=false`
   - `spigot.yml` → `settings.bungeecord: true`
   - **remove EaglerXServer from Paper** (it now runs on Velocity; two
     listeners on the same port fight).
5. Cloudflare tunnel / reverse proxy: point the WebSocket origin at
   **Velocity's 25565** (not Paper). If Cloudflare is in front, configure the
   EaglerXServer listener's `forward_ip` header accordingly.
6. Start Paper, then Velocity. Horizon rejoins `wss://playmc.jonurres.best`.
   Existing 1.12.2 Eaglercraft clients keep working (they negotiate 340).

Verified locally with this exact stack: a full protocol-777 login reaches
`FINISH_LOGIN ack: backend login complete`, and the Horizon release client
rendered the Paper 1.12.2 world.

## Quick check after the change

From a machine with Node:

```
node tools/probe-eagler.mjs wss://playmc.jonurres.best#777 login Test
```

Expected: `SERVER_VERSION` → `ALLOW_LOGIN` → `FINISH_LOGIN ack`. If the
`Outdated server` error is still returned, the backend is still not behind the
new Velocity proxy (or ViaVersion is not loaded).
