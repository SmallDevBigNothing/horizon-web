# Handoff: client-side legacy protocol layer for Horizon 26.3

Status: **not implemented**. This is the brief for the next session/agent.
Scope: **client-side only**. `playmc` and every other server stay untouched.
First target: **Minecraft 1.12.2, protocol 340**. Then 1.8.8 if the design holds.

---

## Paste this as the new session's message

```text
/goal Build a client-side ViaVersion-style legacy protocol layer in Horizon 26.3 (Rust/WASM) so Horizon itself can join Minecraft 1.12.2 (protocol 340) servers with no server-side changes. Implement it now, not just a design: reproduce the 340 handshake, add the 340 codec and translator behind a per-server protocol override, and drive a real join to wss://playmc.jonurres.best until terrain, movement, chat, inventory and health work. Keep the 26.3 path intact, do not copy GPL code into MIT, and do not claim success without a verified join.

# Context you must trust
- Horizon is a Rust/WebAssembly Minecraft 26.3 client in this repo. `crates/horizon-core/src/version.rs` has `PROTOCOL_VERSION = 777`, `VANILLA_VERSION = "26.3"`.
- `crates/horizon-protocol/src/eagler.rs` is the Eagler WebSocket transport. `EaglerSocket` currently offers `crate::PROTOCOL_VERSION` in the Eagler handshake; `EAGLER_PROTOCOL = 5`; after `FINISH_LOGIN` the connection is the plain game protocol, one packet per binary WebSocket message.
- `crates/horizon-client/src/net.rs` sends the 26.3 handshake with `PROTOCOL_VERSION`, does login (`login::Clientbound::LoginFinished`), then the **configuration phase** (`configure`), then `receive_play`.
- `crates/horizon-protocol/src/packets/{handshake,login,configuration,play}.rs` are 26.3 packet enums. `Unknown(id, payload)` preserves unmodelled packets.
- The target server is `wss://playmc.jonurres.best`, Paper 1.12.2 behind EaglerXServer, cracked/offline, 0/20. A probe with `#340` gets `SERVER_VERSION (accepted mc=340)`, `ALLOW_LOGIN`, `FINISH_LOGIN ack: backend login complete`. A probe with `#777` gets `ERROR code=8 {"translate":"Outdated server! I'm still on 1.12.2"}`. The server is not the blocker; Horizon only speaks 777.
- A deployed native 1.12.2 browser client at `https://study.676706767.xyz/horizon/112/` joins playmc. Use it only as a **packet-trace/reference implementation**: open Chrome DevTools -> Network -> WS -> Messages while joining to capture real 1.12.2 frames. Do not copy its code.
- `crates/horizon-world/src/datafix/block_state_data.rs` maps 1.12 block states (`blockId << 4 | data`) to 1.13 states (`upgrade_block_id`, `upgrade_block_state_tag`). `fixes_legacy.rs` covers 1.8->1.12 and `fixes_flat.rs` covers 1.12.2->1.13.2; DataVersion 1343 is 1.12.2. Reuse these instead of inventing block mappings.
- `crates/horizon-client/src/multiplayer.rs` pings servers and currently treats only protocol 777 as compatible (around lines 233-234). `horizon-protocol/src/servers.rs` owns `ServerEntry`/`parse_address`/`websocket_url`; entries currently carry only name and address.
- Licenses: Horizon is MIT. ViaVersion and ViaProxy are **GPL-3.0**. Do not copy their code, classes or mapping tables into Horizon. Use the public protocol docs and generated vanilla data; if you reuse GPL data, isolate it and document the license decision.

# Architecture (recommended)
Add `crates/horizon-legacy` (or `horizon-protocol/src/legacy/` if that is cleaner) with:
1. `LegacyProtocol` (340 first; 1.8.8 later) and a `LegacyCodec`: VarInt framing + zlib compression (reuse `horizon-protocol/src/frame.rs`), 1.12.2 packet ID maps, 1.12.2 data types (strings, positions, slots, metadata).
2. `LegacySession`: owns the Eagler socket with protocol 340, performs the 1.12.2 login, and runs the play loop.
3. `LegacyTranslator`: 1.12.2 clientbound -> 26.3 `play::Clientbound` values/events, and 26.3 serverbound -> 1.12.2 packets. Translate at the packet boundary; do **not** feed 340 bytes into the 26.3 decoder.
4. Protocol selection: per-server `protocol` override, plus a retry flow. Default stays 777.

Critical decision to spike first: **26.3 configuration phase vs 1.12.2 login**.
- 26.3: handshake -> `login::Clientbound::LoginFinished` -> `LoginAcknowledged` -> configuration (`configure`) -> play.
- 1.12.2: handshake -> Login Start -> Login Success -> play, with no configuration and no registry codec.
- Preferred path: after the 1.12.2 Login Success, replay a **canned 26.3 configuration** (registry data, tags, known packs; captured from a local 26.3 server/`horizon-server`), then run the existing play handler on translated 26.3 packets. This keeps `receive_play` unchanged.
- Fallback path: bypass `configure` and initialise the client's registries from the built-in 26.3 defaults/singleplayer registry before `Event::Joined`. Only do this if the canned configuration proves impractical; it touches more client state.
- Record which packets the 26.3 client absolutely requires before play (registry data, feature flags, tags) in `docs/legacy-1.12.2-notes.md`.

# Milestones and acceptance
M0 - Reproduce and capture (do this first)
- Run `node tools/probe-eagler.mjs wss://playmc.jonurres.best#340 login CompatProbe`; confirm `FINISH_LOGIN ack`.
- Capture a full 1.12.2 session with the `/horizon/112` client in Chrome DevTools (WS frames) or a vanilla 1.12.2 client: login, Join Game, chunk, position, chat, inventory, keepalive.
- Write `docs/legacy-1.12.2-notes.md` with the packet IDs you actually observed, the login sequence, and the configuration-phase decision.
- Acceptance: a trace file/fixture exists and the probe prints the ack.

M1 - Codec + login
- Add the protocol override through `EaglerSocket`/`Connection` and `net.rs::join`; keep 777 the default.
- Implement the 340 handshake, Login Start, Set Compression, Login Success; no encryption on cracked servers.
- Connect to playmc with 340 and reach Login Success; disconnect cleanly.
- Acceptance: no `Outdated server`; server logs a login; unit tests for the login packets pass.

M2 - Join Game + position + keepalive
- Translate 1.12.2 Join Game to the 26.3 join state (entity id, gamemode, dimension, seed, max players, view distance, SpawnInfo).
- Translate Player Position/Look, KeepAlive, Client Status.
- Acceptance: player spawns in the world (void/flat is fine), can move for 2 minutes without a kick or panic.

M3 - Terrain
- Translate 1.12.2 Chunk Data (0x20) into 26.3 `ChunkData`/`LightData`.
- Map palette block state IDs with `block_state_data::upgrade_block_id`/`upgrade_block_state_tag` -> 26.3 block state IDs; map biomes; compute heightmaps; map block light/sky light; carry block entities or skip them safely.
- Translate Block Change/Multi Block Change, Unload Chunk.
- Acceptance: real playmc terrain renders; block updates work; no panic; stable 5 minutes.

M4 - Playable
- Chat: 1.12.2 JSON chat -> 26.3 system chat; serverbound chat -> 1.12.2 chat (no signed-chat requirement).
- Inventory: Window Items/Set Slot -> 26.3 container packets; 1.12.2 item id+damage+NBT -> 26.3 stack/components (start with empty/held item and add mappings).
- Health, Respawn, Time, Player List, Spawn/Destroy Entity, Entity Teleport/Look, Animation; metadata mapping for the common indexes only.
- Acceptance: 10-minute session; chat, inventory, health, other players/entities; no desync or kick.

M5 - UX, tests, regression
- Per-server protocol override in `ServerEntry`/servers.dat (backward compatible) and a UI badge/version display; auto-retry: if a 777 login returns `Outdated server`, retry once with 340 and remember it. Note: playmc's status ping can look compatible with 777, so the login retry is the reliable detector.
- Unit/golden tests for codec and mappings; integration test against playmc; 26.3 server regression test.
- Acceptance: `Study` in Horizon joins playmc; a 26.3 server still joins; `cargo test` green; wasm build.

M6 - Polish (only after M5)
- Performance (chunk translation allocations, wasm memory), error messages, docs. Add 1.8.8 only if the `LegacyProtocol` abstraction is clean.

# File map
- `crates/horizon-core/src/version.rs` - protocol/data version constants.
- `crates/horizon-protocol/src/eagler.rs` - Eagler handshake, `EaglerSocket`, protocol field, Read/Write.
- `crates/horizon-protocol/src/frame.rs` - VarInt length + zlib framing; reusable for 340.
- `crates/horizon-protocol/src/packets/{handshake,login,configuration,play}.rs` - 26.3 enums to target.
- `crates/horizon-protocol/src/ids.rs`, `packets/mod.rs` - packet registry/Unknown fallback.
- `crates/horizon-protocol/src/chunk.rs`, `entity_data.rs`, `item.rs` - 26.3 structures to synthesize.
- `crates/horizon-client/src/net.rs` - connection/login/configure/receive_play; the integration point.
- `crates/horizon-client/src/multiplayer.rs` - server list, ping compatibility (lines ~233).
- `crates/horizon-protocol/src/servers.rs` - `ServerEntry`, address/URL parsing.
- `crates/horizon-world/src/datafix/block_state_data.rs` - 1.12 block state -> 1.13 mapping.
- `crates/horizon-world/src/datafix/{fixes_legacy,fixes_flat,mod}.rs` - datafixers, DataVersion 1343.
- `tools/probe-eagler.mjs` - 340/777 login probe.
- `docs/eagler-1.12.2-bridge.md` - the server-side alternative; do not use it as the solution.

# Testing commands
- Probe: `node tools/probe-eagler.mjs wss://playmc.jonurres.best#340 login CompatProbe`
- Unit: `cargo test -p horizon-protocol` (and the new crate)
- Wasm release from the workspace root: `powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-wasm.ps1 -Threaded -Profile release`
- Browser smoke: `node tools/title-probe.mjs <url> <out-prefix>` (existing harness) or deploy `deploy/horizon-lite` to the study domain.
- Regression: join a 26.3 server with the release build; confirm the legacy path is off by default.

# Non-negotiables
- Client-side only. Do not edit playmc, do not add Velocity/ViaVersion to any server, do not require server access.
- Do not regress the 26.3 path; legacy code is opt-in.
- No GPL code/mappings copied into MIT Horizon; document provenance.
- No fake success: a real join with terrain, chat, inventory and health, or it is not done.
- Keep the 1.12.2 client at `/horizon/112` as a reference; do not replace Horizon with it.
```

---

## Why this shape

The first fight is **not** the codec; it is the 26.3 configuration phase. 1.12.2 has no configuration state, no registry codec, and different packet IDs. If you try to reuse the 26.3 play decoder directly you will spend days on "unknown packet" noise. The brief forces an explicit decision (canned 26.3 configuration vs bypass), then a minimal join, then terrain, then the long tail.

The second fight is **data mapping**, not packet framing:
- Blocks: `block_state_data.rs` already maps 1.12 `blockId << 4 | data` to 1.13 states. That is a real head start.
- Items: 1.12.2 item id + damage + NBT -> 26.3 item/components is separate work; start read-only.
- Entities/metadata: 1.12.2 numeric entity types and metadata indexes -> 26.3 registry IDs and serializers; map only what is visible first.
- Chunks: 1.12.2 section format (bits-per-block, palette, longs, light arrays, biomes) -> 26.3 chunk + light; heightmaps must be generated.

The third fight is **detection**. playmc's status can look compatible with 777; the only reliable signal is the login error. Use an explicit per-server protocol override first, then a one-time retry with 340 on `Outdated server`.

## Verified evidence (for the next agent)

```
=== wss://playmc.jonurres.best (MC 340, mode login) ===
  164ms http HTTP/1.1 101 Switching Protocols
  212ms => SERVER_VERSION (accepted mc=340)
  212ms -> REQUEST_LOGIN
  794ms => ALLOW_LOGIN player=CompatProbe
  794ms -> FINISH_LOGIN
  822ms => FINISH_LOGIN ack: backend login complete
```

```
=== wss://playmc.jonurres.best (MC 777, mode login) ===
  => SERVER_VERSION (accepted mc=777)
  -> REQUEST_LOGIN
  => ERROR code=8 {"translate":"Outdated server! I'm still on 1.12.2"}
```

Horizon 26.3 has `PROTOCOL_VERSION = 777` and no 1.12.2 packet definitions. That is the gap this handoff exists to close.
