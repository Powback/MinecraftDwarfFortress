// Stage 1: DF -> MC render. Read a window of the fort (GetBlockList) + units,
// translate DF tiles -> Minecraft blocks and DF creatures -> entities, and stream
// them to the Paper plugin (mc:8686). Coordinate + material translation lives here
// (the plugin speaks raw MC coords), per DESIGN.md §8/§9.

import net from "node:net";
import { DFHackConnection, BoundMethod } from "./dfhack.js";

const DF_HOST = process.env.DF_HOST ?? "127.0.0.1";
const DF_PORT = Number(process.env.DF_PORT ?? 5000);
const MC_HOST = process.env.MC_HOST ?? "mc";
const MC_PORT = Number(process.env.MC_PORT ?? 8686);
const R = Number(process.env.RENDER_R ?? 24);      // horizontal half-window (tiles)
const ZDOWN = Number(process.env.RENDER_ZDOWN ?? 12);
const ZUP = Number(process.env.RENDER_ZUP ?? 5);
const SURFACE_Y = Number(process.env.SURFACE_Y ?? 70); // MC y the fort surface maps to

// TiletypeShape
const SH_EMPTY = 0, SH_NO = -1;
const SOLID_SHAPES = new Set([2, 3, 4, 5]);        // BOULDER, PEBBLES, WALL, FORTIFICATION
const FLOORISH = new Set([1, 6, 7, 8, 9, 10, 11]); // FLOOR, STAIRs, RAMP, RAMP_TOP, BROOK_BED
const TREE_TRUNK = new Set([13, 18]);              // TREE_SHAPE, TRUNK_BRANCH
const TREE_LEAF = new Set([14, 15, 17, 19]);       // SAPLING, SHRUB, BRANCH, TWIG

// TiletypeMaterial -> MC block
function matToBlock(mat: number): string {
  switch (mat) {
    case 1: return "dirt";                 // SOIL
    case 2: case 3: return "stone";        // STONE, FEATURE
    case 4: return "basalt";               // LAVA_STONE
    case 5: return "deepslate";            // MINERAL (approx; ores later)
    case 6: return "ice";                  // FROZEN_LIQUID
    case 7: return "stone_bricks";         // CONSTRUCTION
    case 8: case 9: case 10: case 11: return "grass_block"; // GRASS_*
    case 18: case 22: case 23: return "oak_log"; // DRIFTWOOD, ROOT, TREE_MATERIAL
    case 24: return "mushroom_stem";       // MUSHROOM
    default: return "stone";
  }
}

// Returns MC material name, or null to leave the cell untouched.
function blockFor(
  tt: Map<number, { shape: number; material: number }>,
  tileId: number, hidden: boolean, magma: number, water: number,
): string | null {
  if (hidden) return "stone";              // undiscovered rock => solid mountain
  if (magma > 0) return "lava";
  const info = tt.get(tileId);
  const shape = info?.shape ?? SH_EMPTY;
  const mat = info?.material ?? -1;
  if (water > 0) return "water";
  if (shape === SH_EMPTY || shape === SH_NO || mat === 0) return "air"; // open / AIR
  if (TREE_TRUNK.has(shape)) return "oak_log";
  if (TREE_LEAF.has(shape)) return "oak_leaves";
  if (SOLID_SHAPES.has(shape) || FLOORISH.has(shape)) return matToBlock(mat);
  return "air";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const df = new DFHackConnection(DF_HOST, DF_PORT);
  await df.connect();
  const P = "RemoteFortressReader";
  const bTiletypes = await df.bind("GetTiletypeList", "dfproto.EmptyMessage", `${P}.TiletypeList`, P);
  const bUnits = await df.bind("GetUnitList", "dfproto.EmptyMessage", `${P}.UnitList`, P);
  const bBlocks = await df.bind("GetBlockList", `${P}.BlockRequest`, `${P}.BlockList`, P);

  const ttList = await df.call(bTiletypes);
  const tt = new Map<number, { shape: number; material: number }>();
  for (const t of ttList.tiletypeList ?? []) tt.set(t.id, { shape: t.shape ?? -1, material: t.material ?? -1 });
  console.log(`[render] tiletype table: ${tt.size} entries`);

  const ul = await df.call(bUnits);
  const onMap = (ul.creatureList ?? []).filter((u: any) => u.posX != null); // isValid is unrelated to being on-map
  if (!onMap.length) { console.error("[render] no on-map units — is a fort loaded?"); process.exit(1); }
  // Centre on the surface embark group (highest z cluster), not the average of
  // surface dwarves + deep cave creatures.
  const surfaceZ = Math.max(...onMap.map((u: any) => u.posZ));
  const surface = onMap.filter((u: any) => u.posZ >= surfaceZ - 3);
  let sx = 0, sy = 0;
  for (const u of surface) { sx += u.posX; sy += u.posY; }
  const cx = Math.round(sx / surface.length), cy = Math.round(sy / surface.length);
  const cz = surfaceZ;
  console.log(`[render] ${onMap.length} on-map units; surface group of ${surface.length} at z=${cz}`);
  const Ox = -cx, Oz = -cy, Oy = SURFACE_Y - cz;      // fort centre -> MC (0, SURFACE_Y, 0)
  console.log(`[render] fort centre tile (${cx},${cy}) surface z=${cz}; MC offset O=(${Ox},${Oy},${Oz})`);
  console.log(`[render] fort will appear around MC (0, ${SURFACE_Y}, 0)`);

  // connect to the Paper plugin
  const mc = net.connect(MC_PORT, MC_HOST);
  await new Promise<void>((res, rej) => { mc.once("connect", () => res()); mc.once("error", rej); });
  console.log(`[render] connected to MC plugin at ${MC_HOST}:${MC_PORT}`);
  const send = (o: unknown) => mc.write(JSON.stringify(o) + "\n");

  // request the window of blocks
  const minBX = Math.floor((cx - R) / 16), maxBX = Math.ceil((cx + R) / 16) + 1;
  const minBY = Math.floor((cy - R) / 16), maxBY = Math.ceil((cy + R) / 16) + 1;
  const minZ = cz - ZDOWN, maxZ = cz + ZUP + 1;
  const bl = await df.call(bBlocks, {
    minX: minBX, maxX: maxBX, minY: minBY, maxY: maxBY, minZ, maxZ, blocksNeeded: 200000,
  });
  const blocks = bl.mapBlocks ?? [];
  console.log(`[render] received ${blocks.length} map blocks`);

  let batch: unknown[] = [];
  let total = 0;
  const flush = () => { if (batch.length) { send({ t: "blocks", cells: batch }); total += batch.length; batch = []; } };

  for (const b of blocks) {
    const tiles = b.tiles ?? [], hidden = b.hidden ?? [], magma = b.magma ?? [], water = b.water ?? [];
    for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) {
      const idx = lx * 16 + ly;
      const tx = b.mapX + lx, ty = b.mapY + ly, tz = b.mapZ;
      if (tx < cx - R || tx > cx + R || ty < cy - R || ty > cy + R) continue;
      const blk = blockFor(tt, tiles[idx] ?? 0, hidden[idx] ?? false, magma[idx] ?? 0, water[idx] ?? 0);
      if (blk === null) continue;
      batch.push([tx + Ox, tz + Oy, ty + Oz, blk]);
      if (batch.length >= 2000) flush();
    }
  }
  flush();
  console.log(`[render] sent ${total} blocks to Minecraft`);

  // stream unit positions
  const pushUnits = async () => {
    try {
      const u = await df.call(bUnits);
      const list: unknown[] = [];
      for (const c of u.creatureList ?? []) {
        if (c.posX == null) continue;
        if (Math.abs(c.posX - cx) > R + 6 || Math.abs(c.posY - cy) > R + 6) continue;
        list.push({ id: c.id, x: c.posX + Ox, y: c.posZ + Oy + 1, z: c.posY + Oz, name: c.name || "dwarf" });
      }
      send({ t: "units", list });
    } catch (e) { console.error("[render] unit push error:", (e as Error).message); }
  };
  await pushUnits();
  setInterval(pushUnits, 1000);
  console.log("[render] block render complete; unit stream running (1s). Walk to MC (0, ~72, 0).");
}

main().catch((e) => { console.error("[render] fatal:", e); process.exit(1); });
