// MinecraftEarth — earth sender.
//
// The MinecraftEarth analogue of bridge/src/index.ts: builds a colored voxel
// grid (an ufo-simulator-shaped SdfGrid: {buffer, colors, nx, ny, nz}), repacks
// it into the MDF plugin snapshot protocol via build-snapshot.mjs, opens a TCP
// connection to the mc-earth plugin socket, and streams
//   snap_begin / snap* / snap_end  + a  spawn  command.
// The plugin then GENERATES the 'earth' world from it (DfGenerator, unchanged).
//
// DATA PATH: procedural cityscape (the documented fallback in MINECRAFTEARTH.md
// §7). The real path — voxelizing Google Photorealistic 3D Tiles from
// ufo-simulator (src/lib/mesh-to-sdf.ts) — is browser-side (DRACO decode + a
// live Cesium Ion session) and out of scope for a self-contained runnable demo.
// This sender is a drop-in: swap makeCityscape() for a loader that yields the
// same {buffer, colors, nx, ny, nz} and everything downstream is identical.
//
//   node send-earth.mjs                       # default host :8687
//   MC_HOST=127.0.0.1 MC_PORT=8687 node send-earth.mjs

import net from "node:net";
import fs from "node:fs";
import { buildSnapshot, snapshotMessages } from "./build-snapshot.mjs";

const MC_HOST = process.env.MC_HOST ?? "127.0.0.1";
const MC_PORT = Number(process.env.MC_PORT ?? 8687);
const MC_FLOOR = Number(process.env.MC_FLOOR ?? -60); // MC Y where grid iz=0 sits

// REAL data path: a binary SdfGrid produced by ufo-simulator/earth-producer.mts
// from Google Photorealistic 3D Tiles. When EARTH_GRID points at such a file (or
// the default exists) we stream REAL voxelized terrain; otherwise we fall back to
// the procedural cityscape. See MINECRAFTEARTH-SERVER.md.
const EARTH_GRID = process.env.EARTH_GRID ?? "/tmp/earth-grid.bin";

// Chosen location. In the REAL path this is just a log label (the grid file
// already encodes the location baked by the producer). In the fallback it labels
// the synthetic scene.
const LAT = Number(process.env.LAT ?? 37.8024);   // San Francisco — Russian Hill
const LON = Number(process.env.LON ?? -122.4058);

// ── load a producer-written binary SdfGrid ──────────────────────────────────
// Layout: 'EGRD'(4) | nx,ny,nz (int32 LE) | voxelSize (float32 LE)
//         | Float32 buffer[nx*ny*nz] (Z-major) | Uint8 colors[nx*ny*nz*3]
function loadGridFile(path) {
  const b = fs.readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "EGRD") throw new Error(`${path}: bad magic (not an EGRD grid)`);
  const nx = b.readInt32LE(4), ny = b.readInt32LE(8), nz = b.readInt32LE(12);
  const voxelSize = b.readFloatLE(16);
  const n = nx * ny * nz;
  const bufOff = 20;
  const colOff = bufOff + n * 4;
  // copy into fresh aligned arrays
  const buffer = new Float32Array(n);
  for (let i = 0; i < n; i++) buffer[i] = b.readFloatLE(bufOff + i * 4);
  const colors = new Uint8Array(b.subarray(colOff, colOff + n * 3));
  return { buffer, colors, nx, ny, nz, voxelSize };
}

// ── deterministic RNG (so verification is reproducible) ─────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── procedural cityscape → SdfGrid {buffer, colors, nx, ny, nz} ─────────────
// buffer[iz*ny*nx + iy*nx + ix] : signed distance (<0 = solid). colors: dense RGB.
//   ix = East, iy = North, iz = Up (matches ufo-simulator's ENU frame).
function makeCityscape(nx = 128, ny = 128, nz = 48) {
  const buffer = new Float32Array(nx * ny * nz).fill(1); // +1 = air
  const colors = new Uint8Array(nx * ny * nz * 3);
  const rng = mulberry32(0xEA27);
  const idx = (ix, iy, iz) => iz * ny * nx + iy * nx + ix;
  const solidC = (ix, iy, iz, r, g, b) => {
    const i = idx(ix, iy, iz);
    buffer[i] = -1;
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
  };

  const GROUND = 2;            // ground crust thickness (iz 0..GROUND-1 solid)
  const BLOCK = 24;            // city block pitch (cells)
  const STREET = 6;            // street width (cells)
  const facades = [            // building facade colors (map to concrete/terracotta)
    [207, 213, 214], [190, 200, 205], [150, 150, 150], [120, 120, 120],
    [143, 61, 46], [162, 84, 38], [96, 60, 32], [186, 133, 35],
    [45, 47, 143], [21, 119, 136],
  ];

  // river: a diagonal-ish strip of water on the East side
  const riverCol = (iy) => Math.round(nx * 0.82 + 6 * Math.sin(iy / 14));
  const RIVER_HALF = 7;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const rc = riverCol(iy);
      const inRiver = Math.abs(ix - rc) <= RIVER_HALF;

      // ground crust
      for (let iz = 0; iz < GROUND; iz++) {
        if (inRiver) solidC(ix, iy, iz, 60, 54, 57);          // river bed (dark)
        else solidC(ix, iy, iz, 130, 95, 60);                 // dirt subsurface
      }
      if (inRiver) { solidC(ix, iy, GROUND, 60, 115, 225); continue; } // water surface

      // street grid vs. building lot
      const sx = ix % BLOCK, sy = iy % BLOCK;
      const onStreet = sx < STREET || sy < STREET;
      // central park: a 2x2-block green square near the centre
      const pcx = Math.floor(nx / 2), pcy = Math.floor(ny / 2);
      const inPark = Math.abs(ix - pcx) < BLOCK && Math.abs(iy - pcy) < BLOCK;

      if (inPark) {
        solidC(ix, iy, GROUND, 70, 130, 55);                  // grass top
        // occasional tree (green column)
        if ((ix * 31 + iy * 17) % 53 === 0) {
          const th = 3 + Math.floor(rng() * 3);
          for (let iz = GROUND + 1; iz <= GROUND + th; iz++) solidC(ix, iy, iz, 60, 100, 45);
        }
        continue;
      }
      if (onStreet) {
        solidC(ix, iy, GROUND, 45, 45, 48);                   // asphalt
        continue;
      }
      // sidewalk margin inside the lot
      const inset = 1;
      const lotEdge = sx < STREET + inset || sy < STREET + inset ||
                      sx >= BLOCK - inset || sy >= BLOCK - inset;
      if (lotEdge) { solidC(ix, iy, GROUND, 160, 160, 160); continue; } // concrete sidewalk

      // building interior: one height per lot cell derived from the lot origin
      const loX = ix - sx, loY = iy - sy;
      const h = 5 + Math.floor(mulberry32(loX * 92821 + loY * 53 + 7)() * 32); // 5..36
      const fc = facades[(loX * 7 + loY * 13) % facades.length];
      const top = Math.min(GROUND + h, nz - 1);
      for (let iz = GROUND; iz <= top; iz++) solidC(ix, iy, iz, fc[0], fc[1], fc[2]);
    }
  }
  return { buffer, colors, nx, ny, nz, voxelSize: 1.0 };
}

function findSample(built, name, wantHigh = false) {
  const { snap, SX, SY, SZ, palette, mcOffset } = built;
  const pi = palette.indexOf(name);
  if (pi < 0) return null;
  let found = null;
  for (let ix = 0; ix < SX; ix++)
    for (let iy = 0; iy < SY; iy++)
      for (let iz = wantHigh ? SZ - 1 : 0; wantHigh ? iz >= 0 : iz < SZ; wantHigh ? iz-- : iz++) {
        if (snap[(ix * SY + iy) * SZ + iz] === pi) {
          const mc = [ix + mcOffset.ox, iz + mcOffset.oy, iy + mcOffset.oz];
          if (!found) found = { name, mc, ix, iy, iz };
          if (!wantHigh) return found;
        }
      }
  return found;
}

async function main() {
  let grid, real = false;
  if (fs.existsSync(EARTH_GRID)) {
    grid = loadGridFile(EARTH_GRID);
    real = true;
  } else {
    grid = makeCityscape();
  }
  const ox = -Math.floor(grid.nx / 2), oz = -Math.floor(grid.ny / 2), oy = MC_FLOOR;
  const built = buildSnapshot(grid, { ox, oy, oz });
  console.log(`[earth] location lat=${LAT} lon=${LON} ${real ? `(REAL Google 3D Tiles: ${EARTH_GRID})` : "(procedural fallback)"}`);
  console.log(`[earth] grid ${grid.nx}x${grid.ny}x${grid.nz} = ${grid.nx * grid.ny * grid.nz} voxels`);
  console.log(`[earth] solid: ${built.solid}  palette(${built.palette.length}): ${built.palette.join(", ")}`);

  // Verification samples (exact MC coords + expected block, from the packed snapshot)
  const samples = [
    findSample(built, "grass_block"),
    findSample(built, "mud"),          // asphalt
    findSample(built, "water"),
    findSample(built, "white_concrete", true), // a tall building block
  ].filter(Boolean);
  console.log("[earth] VERIFY samples (world 'earth'):");
  for (const s of samples) console.log(`         ${s.name.padEnd(16)} @ MC ${s.mc.join(" ")}`);

  // Surface centre for spawn: highest solid voxel at the grid centre column.
  const cix = Math.floor(grid.nx / 2), ciy = Math.floor(grid.ny / 2);
  let topIz = 2;
  for (let iz = grid.nz - 1; iz >= 0; iz--) {
    if (grid.buffer[iz * grid.ny * grid.nx + ciy * grid.nx + cix] < 0) { topIz = iz; break; }
  }
  const spawn = { x: 0, y: topIz + oy + 3, z: 0 };

  await new Promise((resolve, reject) => {
    const s = net.connect(MC_PORT, MC_HOST);
    s.once("error", reject);
    s.once("connect", () => {
      console.log(`[earth] connected to plugin ${MC_HOST}:${MC_PORT}; streaming…`);
      let n = 0;
      for (const m of snapshotMessages(built)) { s.write(JSON.stringify(m) + "\n"); n++; }
      s.write(JSON.stringify({ t: "spawn", ...spawn }) + "\n");
      console.log(`[earth] sent ${n} snapshot messages + spawn ${spawn.x},${spawn.y},${spawn.z}`);
      // give the socket a moment to flush before closing
      setTimeout(() => { s.end(); resolve(); }, 1500);
    });
  });
  console.log("[earth] done — plugin generates the 'earth' world. Connect on :25566.");
}

main().catch((e) => { console.error("[earth] fatal:", e); process.exit(1); });
