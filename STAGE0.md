# Stage 0 — DF container + bridge heartbeat

**Goal:** prove the DF → bridge data path. Done when the bridge logs a map size and
a live unit count. See `DESIGN.md` §12 for where this sits.

## What's here

```
df/                     DF 0.47.05 + DFHack 0.47.05-r8, headless (Xvfb), RPC on :5000
  Dockerfile
  entrypoint.sh         Xvfb → (optional VNC) → auto-load save → dfhack
  dfhack-config/remote-server.json   allow_remote:true, port 5000
bridge/                 TypeScript bridge (hot-reloaded via tsx watch)
  src/dfhack.ts         DFHack remote-protocol TCP client (handshake, bind, call)
  src/index.ts          Stage-0 heartbeat
  proto/                DFHack .proto defs (vendored from DFHack 0.47.05-r8)
docker-compose.yaml
saves/                  drop a fort here (or create one, below)
```

## Run it

A fort already exists at `saves/region1/`, so this just works:

```bash
docker compose up --build
```

DF boots headless, auto-loads `region1`, and the bridge prints the map size +
live unit count within ~40s. No manual steps.

## Creating a fresh fort (programmatic, no VNC)

Forts are created by driving DF's UI over RPC with `bridge/src/screen.ts` (read
the screen with `CopyScreen`, inject keys with `PassKeyboardEvent`). The recorded
sequence that generated `region1`: title → `ENTER` (Create New World) → `y` (Go) →
wait for gen → `ENTER` (stop history) → `u` (use world) → `ENTER` (accept) → wait
for save → `ENTER` (Start Playing) → `ENTER` (Dwarf Fortress) → wait for load →
`e` (Embark) → `ENTER` (Play Now) → `ENTER` (dismiss intro) → `ESC` `DOWN` `ENTER`
(Save Game). Drive it with `docker compose exec bridge npx tsx src/screen.ts …`
(see below), dumping the screen between steps.

> Prefer a GUI? `MODE=embark docker compose up df` also serves noVNC at
> `localhost:6080/vnc.html` — but the programmatic route above needs no display.

## Status: STAGE 0 COMPLETE ✅ (real fort data flowing)

Verified end-to-end against a real, embarked fort:
```
[bridge] connected to DFHack at 127.0.0.1:5000
[bridge] DF 0.47.05 / DFHack 0.47.05-r8 / RFR 0.21.0
[bridge] FORT LOADED: "region1" (world: The Realms of Dawning) — 192 x 192 tiles, 187 z-levels
[bridge] units: 30
```
The whole DF→bridge path works: handshake → bind → call → protobuf decode, and
`GetMapInfo`/`GetUnitList` return the live fort's dimensions and unit count.

**The fort was created fully programmatically — no VNC, no clicking.** Using
`CopyScreen` (read DF's text screen) + `PassKeyboardEvent` (inject SDL keys) over
the same RPC, we drove worldgen → history → embark → save. See `bridge/src/screen.ts`.

The fort is persisted at `saves/region1/` (~19 MB) and survives restarts.

### The headless DF screen driver — `bridge/src/screen.ts`
Drive DF's UI from the terminal, no display:
```bash
docker compose exec bridge npx tsx src/screen.ts dump           # print DF's screen as text
docker compose exec bridge npx tsx src/screen.ts key DOWN ENTER # inject keystrokes
docker compose exec bridge npx tsx src/screen.ts keydump y wait:20  # keys, wait, then dump
```
Keys: `UP DOWN LEFT RIGHT ENTER ESC SPACE`, single chars (`e`, `y`, …), `wait:<sec>`.

## Gotchas resolved (learned building this — don't re-discover them)

- **Apple Silicon → `platform: linux/amd64`.** DF/DFHack are x86_64-only; a native
  arm64 base makes qemu fail on `/lib64/ld-linux-x86-64.so.2`. The `df` service is
  pinned to amd64 and runs under Colima's Rosetta.
- **`seccomp:unconfined` on `df`.** DFHack's launcher uses `setarch` (personality
  syscall) to disable ASLR; Docker's default seccomp blocks it → exit 1.
- **Bridge must be `127.0.0.1` to DFHack.** In this build, RemoteFortressReader
  forbids ALL methods from non-localhost clients (`allow_remote` opens the socket
  but the per-method `SF_ALLOW_REMOTE` flag doesn't grant access). So the bridge
  uses `network_mode: "service:df"` and connects to `127.0.0.1:5000`. This is also
  required for the core `RunLua`/`RunCommand` write path in Stage 2 — right call.
- **`chmod +x df/entrypoint.sh` on the host.** It's bind-mounted, so host perms win
  over the image's `chmod`.
- **Hot reload = polling.** virtiofs doesn't deliver inotify events, so `tsx watch`
  never fired. The bridge uses `nodemon --legacy-watch` (polling) instead — verified
  auto-restarting on edit.
- **Docker address pool exhaustion.** If `up` fails with "all predefined address
  pools have been fully subnetted", run `docker network prune -f` (only removes
  networks with no running containers).

- **Cold-start auto-load works.** `docker compose up` boots DF, auto-loads
  `region1` (via `load-save` appended to `dfhack-config/init/dfhack.init`), and the
  bridge reports `FORT LOADED` within ~40s — no manual steps. The init dir doesn't
  exist in a fresh container until first run, so the entrypoint `mkdir -p`s it.

## Wire protocol (for reference)

Handshake `DFHack?\n`+int32(1) ↔ `DFHack!\n`+int32. Messages = `[int16 id][2 pad]
[int32 size]` + protobuf body. Bind a method (id 0, `CoreBindRequest`→`CoreBindReply`)
to get an id, then call it. Replies: RESULT(-1) body, FAIL(-2) code-in-size, TEXT(-3)
console note. Implemented in `bridge/src/dfhack.ts`.
