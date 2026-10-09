# MinecraftDwarfFortress

An experiment in playing Dwarf Fortress inside Minecraft. A headless Dwarf Fortress
(classic 0.47.05 + DFHack) runs in a container; a TypeScript bridge reads the fort over
DFHack's RemoteFortressReader RPC, translates DF tiles into Minecraft blocks, and streams
them to a Paper server plugin that generates a Minecraft world from the fort. Player
block-breaks in Minecraft are sent back to DF as dig designations. The long-term goal
(two-way, both-engines-authoritative sync) is described in [`DESIGN.md`](DESIGN.md); what
exists today is an early prototype.

The repo also contains **MinecraftEarth**, a side experiment that reuses the same plugin
to render voxelized real-world terrain on a second Paper server.

## What it does today

- **Headless DF container** (`df/`): DF 0.47.05 + DFHack 0.47.05-r8 under Xvfb, auto-loads
  the first `region*` save from `saves/`, exposes RemoteFortressReader RPC on port 5000.
  Optional VNC / noVNC for creating a fort by hand (`MODE=embark`).
- **Bridge** (`bridge/`, TypeScript): implements the DFHack remote protocol
  (`src/dfhack.ts`), reads a bounded window of the fort around the embark site, maps DF
  tiletypes/liquids to Minecraft blocks (`src/mapping.ts`), and sends a palette-indexed
  snapshot to the plugin. Also pushes unit (creature) positions every second and turns
  Minecraft block breaks into DF dig designations. Optional live terrain diffing via
  `LIVE_DIFF=1` (off by default for stability).
- **Paper plugin** (`mc-plugin/`, Java 21, Paper API 1.21.4): `MdfReceiver` listens on a
  TCP socket (default 8686) for newline-delimited JSON, generates a world (default name
  `dffort`) from the received snapshot via a custom `ChunkGenerator`, shows units as
  entities, teleports joining players to the fort spawn, and reports block break/place
  events back to the bridge. (The bridge currently acts on `break` only; `place` is sent
  but not yet handled.)
- **Headless DF UI driver** (`bridge/src/screen.ts`): reads DF's text screen and injects
  keystrokes over RPC, so a new world/fort can be created without a display.
- **MinecraftEarth** (`minecraftearth/`): Node scripts that convert a colored voxel grid
  into the same snapshot protocol and stream it to a second Paper server (`mc-earth`).

## Requirements

- Docker with Docker Compose.
- DF and DFHack are x86_64-only. The `df` service is pinned to `linux/amd64`; on Apple
  Silicon this needs an x86 emulation layer (developed with Colima + Rosetta).
- To build the plugin: JDK 21 and Maven. A prebuilt `mc-plugin/target/mdf-receiver.jar`
  is committed.
- For MinecraftEarth: Node.js. Real-world terrain additionally depends on a separate,
  external project that produces the voxel grid (not included here).

## Usage

### 1. Build and install the plugin

```bash
cd mc-plugin
mvn package                      # produces target/mdf-receiver.jar
mkdir -p ../mc/plugins
cp target/mdf-receiver.jar ../mc/plugins/
```

The `mc` service mounts `./mc/plugins` into the itzg Paper image. (`mc/` and `mc-earth/`
are gitignored, so this step is required on a fresh clone.)

### 2. Start the stack

```bash
chmod +x df/entrypoint.sh        # it is bind-mounted, so host permissions apply
docker compose up --build
```

A fort is already committed under `saves/region1/`, so DF boots and auto-loads it. The
bridge waits for DF and the plugin, sends the snapshot, and the plugin generates the
`dffort` world. Connect a Minecraft 1.21.4 client to `localhost:25565` (offline mode,
creative, void world with the fort as the only terrain).

### Creating a new fort

Either use the screen driver from inside the bridge container:

```bash
docker compose exec bridge npx tsx src/screen.ts dump              # print DF's screen
docker compose exec bridge npx tsx src/screen.ts key DOWN ENTER    # inject keys
docker compose exec bridge npx tsx src/screen.ts keydump y wait:20 # keys, wait, dump
```

(the key sequence used to generate `region1` is recorded in [`STAGE0.md`](STAGE0.md)), or
use a GUI:

```bash
MODE=embark docker compose up df   # noVNC at http://localhost:6080/vnc.html, VNC on :5900
```

### Other bridge scripts

Small one-off utilities in `bridge/src/`, run with
`docker compose exec bridge npx tsx src/<file>.ts`:

| Script | Purpose |
|---|---|
| `cmd.ts <command> [args]` | run a DFHack console command (e.g. `reveal`) |
| `pause.ts` / `unpause.ts` | pause / unpause DF |
| `testdig.ts <x> <y> <z>` | designate a dig at a DF tile |
| `maxz.ts`, `solidz.ts` | inspect z-level extents / solid tiles (debugging) |
| `render.ts` | earlier Stage 1 renderer (superseded by `index.ts`) |

`bridge/package.json` scripts: `dev` (nodemon polling watch, used by the container),
`start` (`tsx src/index.ts`), `typecheck` (`tsc --noEmit`).

### MinecraftEarth

```bash
mkdir -p mc-earth/plugins && cp mc-plugin/target/mdf-receiver.jar mc-earth/plugins/
docker compose up -d mc-earth
cd minecraftearth && npm install
MC_HOST=127.0.0.1 MC_PORT=8687 node send-earth.mjs
```

Set `generatedWorld: "earth"` in the plugin config on this server
(`mc-earth/data/plugins/MdfReceiver/config.yml`) so it does not collide with `dffort`.
Join at `localhost:25566`. If `EARTH_GRID` (default `/tmp/earth-grid.bin`) does not exist,
the sender falls back to a procedural cityscape. Producing a real grid from
photorealistic 3D tiles relies on an external project; see
[`MINECRAFTEARTH.md`](MINECRAFTEARTH.md) and
[`MINECRAFTEARTH-SERVER.md`](MINECRAFTEARTH-SERVER.md). `node build-snapshot.mjs` runs a
standalone synthetic-grid check.

## Configuration

**`df` service**

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `run` | `run` = auto-load a save and serve RPC; `embark` = also start VNC/noVNC |
| `AUTO_LOAD` | `1` | auto-load the first `region*` save |
| `DFHACK_DISABLE_CONSOLE` | `1` (compose) | required for headless operation |

**Bridge** (`bridge/src/index.ts`)

| Variable | Default | Meaning |
|---|---|---|
| `DF_HOST` / `DF_PORT` | `127.0.0.1` / `5000` | DFHack RPC endpoint |
| `MC_HOST` / `MC_PORT` | `mc` / `8686` | plugin socket |
| `RENDER_W` | `64` | horizontal half-window around the fort, in tiles |
| `RENDER_ZDOWN` | `48` | z-levels below the surface to render |
| `SURFACE_Y` | `100` | Minecraft Y the fort surface maps to |
| `UNIT_MS` | `1000` | unit position push interval (ms) |
| `LIVE_DIFF` | unset | `1` enables periodic terrain re-sync |
| `RERENDER_MS` | `5000` | live-diff interval (ms) |

The bridge must reach DFHack as `127.0.0.1`: this DFHack build refuses RemoteFortressReader
calls from non-localhost clients, so the bridge shares the `df` container's network
namespace (`network_mode: "service:df"`).

**Plugin** (`mc-plugin/src/main/resources/config.yml`): `port` (8686), `world` (blank =
first world), `generatedWorld` (`dffort`). `drainPerTick` (default 12000) is also read.

**MinecraftEarth sender**: `MC_HOST`, `MC_PORT` (8687), `MC_FLOOR` (-60), `EARTH_GRID`,
`LAT`, `LON`.

**Ports** (from `docker-compose.yaml`): 5000 DF RPC, 5900 VNC, 6080 noVNC, 25565 / 8686
for `mc`, 25566 / 8687 for `mc-earth`.

## Project structure

```
df/               DF + DFHack image, entrypoint, RPC config
bridge/           TypeScript bridge (DFHack client, mapping, scripts) + vendored DFHack .proto files
mc-plugin/        Paper plugin "MdfReceiver" (Maven)
minecraftearth/   Earth-terrain sender prototype
saves/            DF saves, mounted into the df container (region1 is committed)
docker-compose.yaml
DESIGN.md         architecture and staged roadmap
STAGE0.md         Stage 0 notes, gotchas, DFHack wire protocol
MINECRAFTEARTH*.md MinecraftEarth notes
```

## Status

Early, experimental prototype. Per the code: DF -> Minecraft rendering of a bounded fort
window, unit position streaming, and Minecraft break -> DF dig designation work. Building,
liquids sync, conflict resolution and the rest of the two-way sync in `DESIGN.md` are
planned but not implemented (the "Nothing built yet" status line in `DESIGN.md` predates
the current code). Development settings are used throughout: offline-mode Minecraft,
creative mode, and a hard-coded RCON password on `mc-earth` — do not expose these servers
publicly as configured. No license file is included.

Gotchas collected during development (seccomp, Rosetta, polling hot-reload, Docker
address pool exhaustion) are documented in [`STAGE0.md`](STAGE0.md).
