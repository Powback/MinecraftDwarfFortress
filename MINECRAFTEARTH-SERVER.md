# MinecraftEarth — running server

A **second, standalone Paper server** (`mc-earth`) that renders Earth-like terrain
into Minecraft using the **same** `mdf-receiver` plugin as the DF fort. It is fully
independent of the DF fort server (`mc`), the DF container (`df`), and the `bridge`
— separate ports, data dir, plugin socket, and generated world name.

- **Connect (Minecraft client):** `localhost:25566` (offline mode, creative)
- **World generated:** `earth` (the DF fort uses `dffort` — no collision)
- **Data path active:** **REAL Google Photorealistic 3D Tiles** — voxelized headlessly
  in Node from the `ufo-simulator` tile pipeline. Current scene: **San Francisco,
  Russian Hill (37.8024, -122.4058)** — steep hills + dense buildings. A procedural
  cityscape remains as an automatic fallback. See §"Data path" below.

---

## How to run

Two stages: (1) **produce** a voxel grid from real Google 3D Tiles (runs in the
`ufo-simulator` project, which holds the Cesium Ion session + tile cache), then
(2) **stream** that grid into the `mc-earth` plugin.

```bash
cd /Users/macback/Projects/MinecraftDwarfFortress

# 1. Produce a REAL voxel grid from Google Photorealistic 3D Tiles.
#    Runs headlessly in Node from the ufo-simulator dir (needs its tile-proxy
#    session/cache + three/three-mesh-bvh). Writes a binary SdfGrid to /tmp.
cd /Users/macback/Projects/ufo-simulator
LAT=37.8024 LON=-122.4058 R=64 VOXEL=1 HEIGHT=96 OUT=/tmp/earth-grid.bin \
  node --experimental-strip-types earth-producer.mts
cd /Users/macback/Projects/MinecraftDwarfFortress

# 2. Start the second server (first run downloads Paper 1.21.4, ~1–2 min)
docker compose up -d mc-earth

# 3. Wait for the plugin to bind its socket (make sure it's THIS run — check the
#    timestamp; `-t` shows it, and only trust a line newer than your `up -d`).
docker compose logs -t mc-earth | grep "MDF receiver listening" | tail -1

# 4. Stream the produced grid into the plugin (builds the 'earth' world).
#    send-earth.mjs auto-loads EARTH_GRID (default /tmp/earth-grid.bin); if the
#    file is absent it falls back to the procedural cityscape.
cd minecraftearth && EARTH_GRID=/tmp/earth-grid.bin \
  MC_HOST=127.0.0.1 MC_PORT=8687 node send-earth.mjs

# 5. Join at localhost:25566 — you spawn atop the terrain at the AOI centre.
```

**Prereqs (one-time):** `minecraftearth/` has a small `node_modules` with `jpeg-js`
(pure-JS JPEG decoder for the tile albedo textures — `sharp` in ufo-simulator is a
bun-native build that won't load under Node). If missing:
`cd minecraftearth && npm install jpeg-js`. Override its location for the producer
with `JPEGJS_PATH=...`.

Re-running the sender while the world already exists is a no-op for terrain (the
plugin reuses an existing `earth` world). To regenerate from scratch, stop the
server and delete the world:

```bash
docker compose stop mc-earth
rm -rf mc-earth/data/earth mc-earth/data/earth_nether mc-earth/data/earth_the_end
docker compose up -d mc-earth   # then re-run the sender
```

### Ports & layout

| Thing | DF fort (`mc`) | MinecraftEarth (`mc-earth`) |
|---|---|---|
| Minecraft client port | 25565 | **25566** |
| Plugin socket (host→container) | 8686→8686 | **8687→8686** |
| Data dir | `mc/data` | `mc-earth/data` |
| Plugins dir | `mc/plugins` | `mc-earth/plugins` |
| Generated world | `dffort` | `earth` |

---

## Verification (what was checked — REAL San Francisco render)

`docker compose exec -T mc-earth rcon-cli` with `execute in minecraft:earth if block …`
(rcon password `earth`). Grid seated at `ox=-65, oy=-60, oz=-65` (MC X/Z ∈ [-65,64],
MC Y = grid iz + (-60), so Y ∈ [-60, 37]).

**Real terrain relief (not flat)** — topmost solid Y per column varies with the SF
hills (Russian Hill high at the centre, dropping toward the edges):

| Column (MC x,z) | Surface top (MC Y) |
|---|---|
| `0, 0` (centre / Russian Hill) | ~32 |
| `-30, 40` | ~-4 |
| `-50, -50` | ~4–8 |

**Real block variety** (identified by candidate testing):

| MC coord | Block | Meaning |
|---|---|---|
| `0 32 0` | `white_terracotta` | light rooftop / hilltop surface |
| `-61 -31 54` | `grass_block` | vegetation |
| `-50 4 -50` | `mud` | dark street / shadowed ground |
| `-61 -37 -21` | `white_concrete` | building facade |
| `0 20 0` | (solid, not air) | subsurface ground fill |
| `0 60 0` | `air` | above the surface |
| `overworld` @ `0 32 0`, `0 -20 0` | `air` | base void world untouched |

Palette that came out of the real albedo: **29 blocks** — terracottas (light_gray,
gray, brown, white), concretes (white, gray, light_gray, green, pink, cyan, blue,
brown, black), plus grass_block, stone, andesite, gravel, cobblestone, moss_block,
coarse_dirt, dirt, sand, sandstone, mud, oak_log, oak_planks.

Plugin log confirms: `snapshot begin: 130x130x98, 1656200 bytes, palette 29` →
`generating world 'earth'` → `force-loaded 100 chunks (full map)` →
`DF world ready: earth` → `spawn set to 0,35,0`.

---

## Point it at a new lat/lon

The **location lives in the producer**, not the sender — re-run `earth-producer.mts`
with new `LAT`/`LON`, then delete the old `earth` world and re-stream:

```bash
# 1. Produce a new location (pick somewhere with Google Photoreal coverage).
cd /Users/macback/Projects/ufo-simulator
LAT=45.9763 LON=7.6586 R=64 VOXEL=1 HEIGHT=96 OUT=/tmp/earth-grid.bin \
  node --experimental-strip-types earth-producer.mts     # e.g. the Matterhorn

# 2. Regenerate the world (plugin reuses an existing 'earth' world, so delete it).
cd /Users/macback/Projects/MinecraftDwarfFortress
docker compose stop mc-earth
rm -rf mc-earth/data/earth mc-earth/data/earth_nether mc-earth/data/earth_the_end
docker compose up -d mc-earth
docker compose logs -t mc-earth | grep "MDF receiver listening" | tail -1   # wait for THIS run

# 3. Re-stream.
cd minecraftearth && EARTH_GRID=/tmp/earth-grid.bin \
  MC_HOST=127.0.0.1 MC_PORT=8687 node send-earth.mjs
```

**Producer knobs** (`earth-producer.mts`):
- `LAT` / `LON` — AOI centre.
- `R` — horizontal radius in metres → grid is ~`2R+2` wide (64 → 130×130).
- `VOXEL` — metres/voxel = 1 MC block (keep 1; ~1–2 m).
- `HEIGHT` — vertical extent in metres → grid height (96 → 98 tall).
- `GROUND_DEPTH` — solid floor below the lowest terrain (default 4 m).
- `FILL=0` — disable the "fill below topmost surface" pass (leaves the raw hollow
  photogrammetry shell; default on, gives solid Minecraft massing).
- `OUT` — output grid file.
- `JPEGJS_PATH` — override the jpeg-js decoder location.

**Sender knobs** (`send-earth.mjs`): `EARTH_GRID` (grid file to stream; absent →
procedural fallback), `MC_FLOOR` (default -60, MC Y where grid `iz=0` sits).

Keep `R`/`HEIGHT` modest — the DF side had watchdog crashes from oversized renders.
64/96 (130×130×98 ≈ 1.65 M cells) force-loads 100 chunks and streams cleanly.

---

## Data path

**Active: REAL Google Photorealistic 3D Tiles, voxelized headlessly in Node.**

Pipeline (Option B from `MINECRAFTEARTH.md` — pure Node, no browser):

```
lat/lon/R ─► ufo-simulator/earth-producer.mts  (runs in the ufo-simulator dir)
  ├─ getRootPath()/fetchTile*  → resolve the Cesium Ion → Google session, fetch
  │    the 3D-Tiles root, and DESCEND the tile tree LIVE, gathering the deepest
  │    .glb leaf tiles whose bounding volume overlaps the AOI disc (horizontal
  │    distance test in the ENU frame — vertical is ignored so elevated terrain
  │    isn't spuriously rejected).
  ├─ per leaf GLB: parse the container, read plain glTF FLOAT accessors
  │    (POSITION + TEXCOORD_0 + indices), apply the glTF node matrix → glTF world,
  │    then the Y-up→Z-up rotation (x,y,z)→(x,-z,y) → ECEF, then the inverse ENU
  │    frame at the AOI centre → local (x=E, y=N, z=Up).
  ├─ per leaf: decode the albedo JPEG (jpeg-js) and sample it per vertex → RGB.
  ├─ merge every leaf into ONE triangle soup + per-vertex colors, build ONE
  │    three-mesh-bvh, and voxelize (same closest-point + face-normal SDF sign
  │    logic as src/lib/mesh-to-sdf.ts positionsToSdf), coloring each voxel by
  │    barycentric interpolation of the nearest triangle's vertex colors.
  ├─ FILL pass: photogrammetry is a thin shell, so fill every voxel below each
  │    column's topmost surface voxel → solid Minecraft massing (colors are dense).
  └─ write a binary SdfGrid file  { 'EGRD', nx,ny,nz, voxelSize, Float32 buffer,
       Uint8 colors }  (Z-major, index = iz*ny*nx + iy*nx + ix; sdf<0 = solid).
                                                     │
   send-earth.mjs (UNCHANGED downstream):            ▼
     loadGridFile(EARTH_GRID) → buildSnapshot() (build-snapshot.mjs, repack +
     palette.mjs color→block) → snap_begin/snap*/snap_end + spawn over TCP :8687
                                                     │
   MDF plugin (UNCHANGED) ── DfGenerator builds the 'earth' world ──► player
```

**DRACO note:** the crux was expected to be DRACO decode, but this Cesium-Ion
Google Photoreal asset serves **uncompressed** GLB tiles (plain FLOAT VEC3
accessors — verified across coarse + deep-LOD leaves; `dracoSkipped=0` every run).
`earth-producer.mts` still detects `KHR_draco_mesh_compression` and skips such
primitives with a warning, so a DRACO tile would degrade gracefully rather than
corrupt the mesh; a full Node DRACO path was not needed for this dataset.

**Credentials:** `src/lib/tile-proxy.ts` carries a working Cesium Ion JWT
(`CESIUM_ION_TOKEN` env overrides it). The persisted session token expires, but the
producer transparently re-resolves a fresh one from the JWT on the first upstream
fetch, and there is a warm disk cache (`data/tile-cache/`, ~168 k GLBs) that serves
previously-visited areas offline. New locations need working outbound network to
`api.cesium.com` + `tile.googleapis.com`.

### Coordinate mapping (unchanged, correct for real ENU grids)

`build-snapshot.mjs` maps `ix→East→MC X`, `iy→North→MC Z`, `iz→Up→MC Y`, solid where
`sdf < 0`, at 1 voxel = 1 m = 1 MC block. The grid is seated with
`ox=-nx/2, oz=-ny/2, oy=MC_FLOOR` and the player spawns above the AOI-centre column.

### Fallback

If `EARTH_GRID` is absent, `send-earth.mjs` falls back to `makeCityscape()` — a
deterministic 128×128×48 procedural Manhattan grid (buildings, streets, park, river)
— so the demo still runs with no network / no producer step.

---

## Plugin change made

To avoid a world-name collision, the plugin's generated-world name is now
**config-driven** (was hardcoded `"dffort"`):

- `mc-plugin/src/main/java/com/mdf/MdfPlugin.java` — reads
  `getConfig().getString("generatedWorld", "dffort")`; used in `createDfWorld()`.
- `mc-plugin/src/main/resources/config.yml` — documents the `generatedWorld` key.
- `mc-earth/data/plugins/MdfReceiver/config.yml` — sets `generatedWorld: "earth"`.

The DF fort server is unaffected (defaults to `dffort`). Rebuild the jar with:

```bash
docker run --rm -v "$PWD/mc-plugin":/build -v "$PWD/mc/plugins-earth":/out \
  -v mdf-m2:/root/.m2 -w /build maven:3.9-eclipse-temurin-21 \
  sh -c "mvn -q -DskipTests package && cp target/mdf-receiver.jar /out/"
```

The earth server loads the jar from `mc-earth/plugins/mdf-receiver.jar`.
