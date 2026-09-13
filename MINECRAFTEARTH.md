# MinecraftEarth — render real-world locations in Minecraft

Feed voxelized **Google Photorealistic 3D Tiles** (via the `ufo-simulator`
project) into the existing MinecraftDwarfFortress (MDF) Paper plugin, reusing the
`snapshot → ChunkGenerator` pipeline **unchanged**. Swap the DF tile source for
voxelized Earth data.

Status: scoping + light prototype. Prototype lives in `minecraftearth/`
(`palette.mjs`, `build-snapshot.mjs`) — both run standalone under `node`, no deps.

---

## 1. The reuse insight (verified)

The MDF plugin is **data-source-agnostic**. `DfGenerator` (a Bukkit
`ChunkGenerator`) renders a world from one flat structure:

- `byte[] snap` — palette index per cell, `0` = air
- dims `sx, sy, sz`; MC offset `ox, oy, oz`
- `Material[] palette` — index → `Material`

`MdfPlugin` receives it over TCP on **:8686** as newline-delimited JSON:
`snap_begin {sx,sy,sz,ox,oy,oz,total,palette[]}` → many `snap {off, data(base64)}`
→ `snap_end`. Anything that can emit a palette-indexed voxel grid drives it.

**Snapshot index + frame (exact, from `DfGenerator.java` + `mapping.ts`):**
```
index = (dfx*sy + dfy)*sz + dfz          // dfz (vertical axis) is contiguous
mc    = (dfx+ox,  dfz+oy,  dfy+oz)        // dfx→MC X, dfz→MC Y(up), dfy→MC Z
```
Palette entries are Minecraft block ids as **lowercase strings**
(`"grass_block"`, `"stone"`, `"oak_log"`, …). Plugin resolves them via
`Material.matchMaterial(name)`, falling back to `STONE`; `"air"` → `AIR`
(`MdfPlugin.mat()`). So our color→block mapper just needs to output valid MC
block ids — no plugin change.

**Nothing in the plugin or bridge needs modifying.** MinecraftEarth is a new
sender that speaks the same protocol.

---

## 2. What `ufo-simulator` actually does (grounded in its code)

> Note: the project the task calls "ufosim" is at `/Users/macback/Projects/ufo-simulator`
> (siblings `UFO` and `UFOSimProd` are unrelated). Its top-level `CLAUDE.md` is a
> SpacetimeDB template; the tile system is documented in `docs/tile-system/*.md`.

### 2a. Fetching Google Photorealistic 3D Tiles — `src/lib/tile-proxy.ts`
- **Upstream:** `https://tile.googleapis.com/v1/3dtiles/datasets/CgIYAQ/…`
- **Auth chain:** Cesium Ion JWT → Google API key + session token. The Cesium
  Ion endpoint (`https://api.cesium.com/v1/assets/2275207/endpoint`) returns the
  Google Tiles URL + API key; the Google root tileset JSON carries a `session`
  query param that must be re-supplied on every tile fetch.
- **Cache:** disk cache in `data/tile-cache/`, keyed by **bounding volume**
  (`bvKey = sha1(kind + ':' + bv.box/sphere/region rounded)`), stable across
  sessions (raw URIs rotate). Sidecar `bv-meta` holds `upstreamUri`, `ext`,
  ECEF `bv` sphere, raw OBB `box[12]`. A sibling `worldsim` project provides
  ~8.7 GB of pristine tiles mounted read-only.
- **lat/lon → tile:** `bvKeyContaining(lat, lon)` walks the tile tree from root,
  descending into children whose bounding volume contains the radial column
  through `(lat,lon)`, returning the deepest-covering `.glb` leaf (highest LOD).
- Tiles arrive as **GLB meshes** (textured photogrammetry), **DRACO-compressed**
  (`KHR_draco_mesh_compression`), in **ECEF metres** (Earth-Centered fixed).
  Geometry = ground + buildings + trees baked into one textured mesh.

### 2b. Voxelization — `src/lib/mesh-to-sdf.ts` (this is the core we reuse)
A **generic mesh → SDF voxel converter**, explicitly DOM/React-free (runs in a
Web Worker via `src/components/zurich/sdf-worker.ts`). Key function:

```
positionsToSdf(positions: Float32Array,   // world-space triangle soup (metres)
               voxelSize: number,          // metres/voxel (1.0 → 1 MC block)
               bounds?: THREE.Box3,        // sub-region to voxelize
               { uvs, texture, emitUv })
  → { grid: SdfGrid, stats }
```
`SdfGrid`:
- `buffer: Float32Array` signed distance per cell, **Z-major**
  `index = iz*(ny*nx) + iy*nx + ix`. Negative = **inside** the surface
  (below terrain / inside a building). Sign from the closest triangle's face
  normal — works on open/non-watertight meshes.
- `nx, ny, nz`, `origin`, `voxelSize`.
- `colors?: Uint8Array` — **per-voxel RGB sampled from the tile's albedo
  texture** (barycentric UV at the closest surface point). Filled densely (every
  voxel gets the color of its nearest surface point). This is the
  "Minecraft Zurich" albedo mode — **exactly the color source we need.**
- `toWorld?: number[]` — optional local→world matrix when voxelized in a local
  frame (see below).

Geometry extraction: `extractWorldGeometry(root)` → `{positions, uvs}` (de-indexed
triangle soup + matching UVs), and `extractWorldPositions(root)`. Uses
`three-mesh-bvh` for O(log n) closest-point queries.

### 2c. The working end-to-end reference — `src/components/ZurichSdfDebug.tsx`
This is the **template for MinecraftEarth's producer**. Per streamed leaf tile it:
1. `latLonToEcef(lat, lon, alt)` (WGS84: `A=6378137`, `E2=6.69438e-3`) for the
   AOI centre.
2. `enuToWorld(center)` = `makeBasis(east, north, up).setPosition(center)` — a
   **local ENU frame**. In this frame: **local x = East, local y = North,
   local z = Up**.
3. Extract tile geometry + UVs, apply the **inverse ENU transform** to the
   positions so the voxel lattice stacks along local Up (ground reads flat,
   up = +z).
4. Rasterize the tile albedo texture → `TexelSource`.
5. `positionsToSdf(positions, voxelSize, bounds, {uvs, texture})` in the worker
   → `SdfGrid` with `buffer` + `colors`, stamped with `toWorld = ENU matrix`.

DRACO decode is handled in-browser by `src/lib/tile-loaders.ts`
(`createDracoLoader()`, gstatic decoder, 8-worker pool). `three`, `three-mesh-bvh`,
`3d-tiles-renderer` are the relevant deps.

### 2d. Variable resolution / LOD
3D Tiles are a hierarchical LOD tree; `TilesRenderer` descends by screen-space
error. `mesh-to-sdf` is **resolution-agnostic** — `voxelSize` + `bounds` are
per-call params. The prototype design captured in
`.master-agent/zurich-sdf-terrain-prototype.md` calls for coarse voxels far
(8–16 m), fine near (0.5–1 m). For MinecraftEarth we pick **one fixed LOD** (the
leaf/near tiles) and **voxelSize = 1 m = 1 MC block**.

### Reality check on "voxelize": it exists, but is **browser-side today**
There is **no offline Node CLI** that emits an SDF grid. The voxelizer core
(`mesh-to-sdf.ts`) is pure compute and Node-safe, but the two things around it
are browser-oriented: (a) DRACO decode uses the browser `DRACOLoader`, and (b)
`ZurichSdfDebug.tsx` drives it from React/three inside `TilesRenderer`. The
server-side carver (`glb-carver.ts`) parses the GLB container manually and
does **texture-domain** destruction (via `sharp`) + a Rust helper
(`tools/carver-rs`, no glTF/DRACO deps) — it does **not** DRACO-decode geometry.
So getting a voxel grid headlessly is the main integration work (see §6).

---

## 3. How to get a voxel grid (colors) for a lat/lon/radius

**Target contract:** `{ buffer, colors, nx, ny, nz, voxelSize, toWorld }` (an
`SdfGrid`) for an AOI centred at `(lat, lon)` with a horizontal radius `R` metres,
at `voxelSize = 1 m`.

Two viable producers (both reuse `mesh-to-sdf.ts` unchanged):

- **Option A — headless browser (fastest to working demo).** Run the existing
  `/zurich`-style page in Playwright (ufo-simulator already ships a Playwright
  farm, `cb-mcp-stdb`), point it at `(lat,lon)`, let `TilesRenderer` +
  `createDracoLoader` stream + DRACO-decode leaf tiles, run
  `extractWorldGeometry` + `positionsToSdf` per tile in the ENU frame, and
  `postMessage`/dump each resulting `SdfGrid` (buffer + colors + toWorld) out of
  the page (e.g. to a WebSocket or `window`-exposed callback). Zero new decode
  code; reuses the verified pipeline verbatim.

- **Option B — pure Node producer (cleaner long-term, more upfront work).**
  In Node/Bun: fetch tiles via `tile-proxy` (or the `/api/3dtiles-baked/root` +
  `bv/<key>.glb` endpoints), DRACO-decode with `three`'s `DRACOLoader` + the wasm
  decoder (or `gltf-transform` + a draco module), build a `THREE.Object3D`,
  then call the **existing** `extractWorldGeometry` + `positionsToSdf`. This is
  the same core, just fed from Node instead of the renderer.

Either way the AOI is assembled by: `bvKeyContaining(lat,lon)` → gather the leaf
tiles overlapping the `R`-radius disc → voxelize each into the **same** ENU frame
(shared `center`) with a shared `bounds` box so all tiles land on one lattice →
merge (min-SDF where they overlap; take colors from the tile with `|sdf|`
smallest).

---

## 4. MinecraftEarth integration design

### 4a. Data flow
```
lat/lon/R ─► ufo-simulator producer (Option A or B)
             ├─ fetch Google Photoreal leaf tiles (tile-proxy, DRACO GLB, ECEF)
             ├─ ENU frame at (lat,lon,0):  makeBasis(east,north,up)
             ├─ extractWorldGeometry → positions+uvs (inverse-ENU'd) + albedo texel
             └─ positionsToSdf(1 m)  → SdfGrid { buffer, colors, nx,ny,nz }
                                              │
   NEW SENDER (minecraftearth/):              ▼
   buildSnapshot(grid, mcOffset)   ── repack + color→block palette ──►
   snapshotMessages()   ──  snap_begin / snap*/ snap_end over TCP :8686  ──►
                                              │
   MDF plugin (UNCHANGED) ── DfGenerator builds the 'dffort' world ──► player
```

### 4b. Coordinate mapping (the load-bearing part — implemented in the stub)
`SdfGrid` is voxelized in the ENU frame, so:
`ix → East`, `iy → North`, `iz → Up (vertical)`.
MDF wants `index=(dfx*SY+dfy)*SZ+dfz` with `mc=(dfx+ox, dfz+oy, dfy+oz)`
(`dfx→MC X`, `dfz→MC Y up`, `dfy→MC Z`). Map:

```
dfx = ix           (East  → MC X)        SX = nx
dfz = iz           (Up    → MC Y)        SZ = nz
dfy = iy           (North → MC Z)        SY = ny
snap[(ix*ny + iy)*nz + iz] = paletteIndexOf(voxel)
```
Optional: `dfy = ny-1-iy` to make MC +Z point South (MC's convention). Solid
test: `sdf < 0` (below the surface / inside a building). `mcOffset` seats the
grid: `oy = MC_FLOOR - <voxels below surface>` so the terrain surface lands at a
sensible MC Y (mirrors `bridge`'s `MC_FLOOR = -64`); `ox/oz` centre the AOI on
MC (0,0). Because ENU is metric and voxelSize = 1 m, **1 voxel = 1 m = 1 MC
block** with no rescale.

### 4c. Color → block palette
Curated palette of solid, full-cube, matte blocks (`minecraftearth/palette.mjs`,
39 blocks): naturals (grass/dirt/stone/sand/sandstone/gravel/snow/mud/oak) +
**concrete ×16** (flat saturated — built color) + **terracotta** (earthy roofs/
facades). Nearest color via **redmean** perceptual distance. Per-voxel color is
quantized to a 15-bit bucket and memoized so `blockForColor` runs ~once per
distinct color, not per voxel. Validated samples:

| input | → block |
|---|---|
| forest green (70,130,55) | `grass_block` |
| red brick (150,55,45) | `red_terracotta` |
| beach sand (225,210,165) | `sand` |
| terracotta roof (170,80,45) | `orange_terracotta` |
| dry soil (130,95,60) | `dirt` |
| snow (248,250,250) | `snow_block` |
| glass tower (190,205,210) | `white_concrete` |
| asphalt (45,45,48) | `mud` |
| deep water (40,90,170) | `cyan_concrete` |

Refinements worth doing: add gray_wool/deepslate/blackstone for asphalt; a real
blue for water (the muted-blue sample lands on cyan_concrete). Consider
semantic hints (top-most solid voxel of a green column → `grass_block`, below →
`dirt`) rather than pure per-voxel color, to avoid speckle.

### 4d. What code to write
A new **`minecraftearth/` sender**, analogous to `bridge/src/index.ts`:
1. **Producer glue** (Option A Playwright driver *or* Option B Node loader) that
   yields `SdfGrid`s for an AOI. Reuses `ufo-simulator`'s `mesh-to-sdf.ts`,
   `tile-loaders.ts`, ENU helpers from `ZurichSdfDebug.tsx` (worth extracting
   `latLonToEcef`/`enuToWorld` into a shared lib).
2. **`buildSnapshot(grid, mcOffset)`** — repack + palette (prototyped:
   `minecraftearth/build-snapshot.mjs`).
3. **`sendSnapshot`** — TCP connect to `MC_HOST:8686`, write
   `snap_begin`/`snap`(48000-byte base64 chunks)/`snap_end` + `\n`, then a
   `spawn {x,y,z}` at surface (copy verbatim from `bridge/src/index.ts`).
No plugin/bridge edits. Optionally add a compose service mirroring `bridge/`.

---

## 5. Prototype (in `minecraftearth/`, runnable now)
- **`palette.mjs`** — 39-block curated palette + redmean `blockForColor()` +
  self-test (`node palette.mjs`).
- **`build-snapshot.mjs`** — `buildSnapshot()` (repack + coord map + palette) and
  `snapshotMessages()` (exact MDF protocol). Demo builds a synthetic hill+wall
  grid → `node build-snapshot.mjs` outputs:
  `grid 48x48x32; solid 24944; palette(4): air, grass_block, dirt,
  red_terracotta; 4 messages, 96.2 KB wire`. Proves the repack, coordinate
  mapping, palette, and wire format end-to-end without ufosim/three.

---

## 6. Open questions & risks
1. **Headless voxelization (biggest).** The voxelizer runs browser-side today.
   Option A (Playwright over the existing page) is the low-risk path; Option B
   (Node DRACO decode + loader) is cleaner but needs the wasm draco decoder
   wired and the tile-tree walk reimplemented in Node. Decide before building.
2. **DRACO decode.** Google GLBs are `KHR_draco_mesh_compression`. The
   server-side carver does NOT decode geometry — only the browser path
   (`createDracoLoader`) does. Any Node producer must add a decoder.
3. **Multi-tile AOI stitching.** Need all AOI tiles in one shared ENU frame +
   shared `bounds` so voxels align; merge overlaps by min-|SDF|. Untested here.
4. **Memory / size.** 1 m voxels: 1 km² × 100 m tall = 1e8 cells. `buffer` is
   4 B/cell + snapshot 1 B/cell. Keep AOI modest first (e.g. 256×256×128 ≈ 8.4 M
   cells, ~8 MB snapshot, well within the chunked protocol). MC height range is
   -64..319 (384) — cap `nz`/vertical extent accordingly.
5. **Non-watertight sign errors.** Photogrammetry meshes are open; `mesh-to-sdf`
   signs by face normal. Overhangs/thin walls can misclassify solid/air. May
   need a "fill everything below the top surface voxel" post-pass for clean
   ground.
6. **Palette fidelity.** Water and dark asphalt are weak (see §4c). Small palette
   tweaks + semantic column rules will help. Trees are baked into terrain (no
   segmentation) — they'll voxelize as green blobs; acceptable for v1.
7. **Tile auth/session.** Producer must hold a live Cesium Ion session (or hit a
   warm `data/tile-cache`). Running inside `ufo-simulator`'s app container reuses
   its session + cache for free — the natural home for the producer.
8. **Georeference.** ENU +z = ellipsoidal up; over a large AOI the flat MC world
   ignores Earth curvature. Fine for ≤ a few km; note for larger scenes.

## 7. Recommended first build
Option A end-to-end thin slice: drive the ufo-simulator page headless for one
lat/lon, dump a single leaf tile's `SdfGrid` to disk, feed it through the
prototype `buildSnapshot`, send to a running MDF plugin, walk around it. Then
extend to multi-tile AOI and refine the palette.
