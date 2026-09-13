// MinecraftEarth — snapshot builder stub (prototype).
//
// Repacks a ufo-simulator SdfGrid (from src/lib/mesh-to-sdf.ts positionsToSdf,
// voxelized in a LOCAL ENU frame with per-voxel `colors`) into the exact MDF
// plugin snapshot protocol (snap_begin / snap / snap_end), reusing the plugin
// and its DfGenerator UNCHANGED. This is the MinecraftEarth analogue of
// bridge/src/index.ts buildSnapshot()/sendSnapshot().
//
// Run with a synthetic grid (a hill + a wall) to prove the repack + coordinate
// mapping + palette without needing ufosim/three:  `node build-snapshot.mjs`
//
// ── Coordinate mapping (the load-bearing part) ─────────────────────────────
// ufosim SdfGrid (ENU frame, makeBasis(east,north,up)):
//   buffer[iz*ny*nx + iy*nx + ix], voxel center = origin + (i+0.5)*voxelSize
//     ix -> East   (local x)
//     iy -> North  (local y)
//     iz -> Up     (local z)   ← vertical
//   sdf < 0  => inside the surface (below terrain / inside a building) = SOLID
//   colors[cellIdx*3 .. +2] = RGB of nearest surface point (dense fill)
//
// MDF snapshot (DfGenerator): index = (dfx*SY + dfy)*SZ + dfz
//   mc = (dfx+ox, dfz+oy, dfy+oz)   → dfx=MC X, dfz=MC Y (vertical), dfy=MC Z
//
// So we map:  dfx = ix (East→MC X) ; dfz = iz (Up→MC Y) ; dfy = iy (North→MC Z)
//   → SX = nx, SY = ny, SZ = nz
//   → snapshot[(ix*ny + iy)*nz + iz] = paletteIndexOf(voxel ix,iy,iz)
// (Optionally flip North so MC +Z points South to match MC's convention:
//  dfy = (ny-1-iy). Left off here for clarity.)

import { blockForColor } from "./palette.mjs";

const VOXEL_M = 1.0; // 1 metre voxel == 1 MC block

/**
 * @param {{buffer:Float32Array, colors?:Uint8Array, nx:number, ny:number, nz:number, voxelSize:number}} grid
 * @param {{ox:number, oy:number, oz:number}} mcOffset  where grid origin sits in MC
 * @param {(sdf:number)=>boolean} isSolid
 */
export function buildSnapshot(grid, mcOffset, isSolid = (s) => s < 0) {
  const { buffer, colors, nx, ny, nz } = grid;
  const SX = nx, SY = ny, SZ = nz;
  const snap = new Uint8Array(SX * SY * SZ); // 0 = air

  const paletteIndex = new Map([["air", 0]]);
  const paletteArr = ["air"];
  const palId = (name) => {
    let i = paletteIndex.get(name);
    if (i === undefined) { i = paletteArr.length; paletteIndex.set(name, i); paletteArr.push(name); }
    return i;
  };
  // quantized-color cache so blockForColor runs ~once per distinct color, not per voxel
  const colorCache = new Map();
  const idForColor = (r, g, b) => {
    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3); // 15-bit bucket
    let name = colorCache.get(key);
    if (name === undefined) { name = blockForColor([r, g, b]); colorCache.set(key, name); }
    return palId(name);
  };

  let solid = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const src = iz * ny * nx + iy * nx + ix;
        if (!isSolid(buffer[src])) continue;
        const dst = (ix * SY + iy) * SZ + iz; // ← MDF layout
        if (colors) {
          snap[dst] = idForColor(colors[src * 3], colors[src * 3 + 1], colors[src * 3 + 2]);
        } else {
          snap[dst] = palId("stone");
        }
        solid++;
      }
    }
  }

  return { snap, SX, SY, SZ, palette: paletteArr, mcOffset, solid };
}

/** Emit the newline-delimited JSON messages the MDF plugin expects (port 8686). */
export function* snapshotMessages(built) {
  const { snap, SX, SY, SZ, palette, mcOffset } = built;
  yield { t: "snap_begin", sx: SX, sy: SY, sz: SZ,
          ox: mcOffset.ox, oy: mcOffset.oy, oz: mcOffset.oz,
          total: snap.length, palette };
  const CHUNK = 48000;
  for (let off = 0; off < snap.length; off += CHUNK) {
    const slice = snap.subarray(off, Math.min(off + CHUNK, snap.length));
    yield { t: "snap", off, data: Buffer.from(slice).toString("base64") };
  }
  yield { t: "snap_end" };
}

// --- demo with a synthetic grid: a green hill + a red-brick wall ------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const nx = 48, ny = 48, nz = 32;
  const buffer = new Float32Array(nx * ny * nz);
  const colors = new Uint8Array(nx * ny * nz * 3);
  const setC = (i, r, g, b) => { colors[i*3]=r; colors[i*3+1]=g; colors[i*3+2]=b; };
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++) {
        const i = iz*ny*nx + iy*nx + ix;
        // dome terrain: height falls off from the centre
        const dx = ix - nx/2, dy = iy - ny/2;
        const h = 18 - 0.02 * (dx*dx + dy*dy);
        let sdf = iz - h;                    // <0 below surface = solid ground
        let col = [70, 130, 55];             // grass green
        if (iz < h - 4) col = [130, 95, 60]; // dirt below
        // a wall along iy==24, ix 10..38, up to iz 10
        if (iy === 24 && ix >= 10 && ix <= 38 && iz <= 10) { sdf = -1; col = [150, 55, 45]; }
        buffer[i] = sdf;
        setC(i, col[0], col[1], col[2]);
      }

  const built = buildSnapshot({ buffer, colors, nx, ny, nz, voxelSize: VOXEL_M },
                              { ox: -nx/2, oy: -64, oz: -ny/2 });
  console.log(`grid ${nx}x${ny}x${nz} = ${nx*ny*nz} voxels`);
  console.log(`solid: ${built.solid}  palette(${built.palette.length}): ${built.palette.join(", ")}`);
  let bytes = 0, msgs = 0;
  for (const m of snapshotMessages(built)) { bytes += JSON.stringify(m).length + 1; msgs++; }
  console.log(`protocol: ${msgs} messages, ${(bytes/1024).toFixed(1)} KB wire (base64 JSON)`);
  console.log(`→ would connect to MC plugin :8686 and write each message + "\\n" (see bridge/src/index.ts sendSnapshot)`);
}
