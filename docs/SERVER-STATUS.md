# Server status

`playmc.jonurres.best` is **Minecraft 26.3 (protocol 777)**.

Verified on 2026-11-02:

- Eagler probe with `#777`: `SERVER_VERSION` -> `ALLOW_LOGIN` ->
  `FINISH_LOGIN ack: backend login complete`.
- Horizon 26.3 release client: joins the server and renders the world.

No client-side legacy protocol layer is required for this server. The 1.12.2
handoff and the server-side bridge notes are archived in `docs/archive/`.
