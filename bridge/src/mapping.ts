// DF <-> MC coordinate + material translation (DESIGN.md §8).

// TiletypeShape ids
const SH_EMPTY = 0, SH_NO = -1;
const SOLID_SHAPES = new Set([2, 3, 4, 5]);          // BOULDER, PEBBLES, WALL, FORTIFICATION
const FLOORISH = new Set([1, 6, 7, 8, 9, 10, 11]);   // FLOOR, STAIRs, RAMP, RAMP_TOP, BROOK_BED
const TREE_TRUNK = new Set([13, 18]);                // TREE_SHAPE, TRUNK_BRANCH
const TREE_LEAF = new Set([14, 15, 17, 19]);         // SAPLING, SHRUB, BRANCH, TWIG

// TiletypeMaterial -> MC block
function matToBlock(mat: number): string {
  switch (mat) {
    case 1: return "dirt";
    case 2: case 3: return "stone";
    case 4: return "basalt";
    case 5: return "iron_ore";   // MINERAL vein -> visible ore
    case 6: return "ice";
    case 7: return "stone_bricks";
    case 8: case 9: case 10: case 11: return "grass_block";
    case 18: case 22: case 23: return "oak_log";
    case 24: return "mushroom_stem";
    default: return "stone";
  }
}

export type TileInfo = { shape: number; material: number };

/** MC block name for a DF tile, or null to skip.
 *  `outside` = DF's sky-exposed flag: surface floor tiles are solid ground, but
 *  underground floor/open tiles are AIR so dug-out rooms & caverns are hollow
 *  (and digging visibly opens space). Material is used regardless of `hidden`
 *  (X-ray: ore veins/caverns show without needing `reveal`). */
export function blockFor(
  tt: Map<number, TileInfo>,
  tileId: number, magma: number, water: number, outside: boolean,
): string | null {
  if (magma > 0) return "lava";
  if (water > 0) return "water";
  const info = tt.get(tileId);
  if (!info) return null;                 // unknown tiletype -> skip (never delete)
  const shape = info.shape, mat = info.material;
  if (shape === SH_EMPTY || shape === SH_NO || mat === 0) return "air";
  if (TREE_TRUNK.has(shape)) return "oak_log";
  if (TREE_LEAF.has(shape)) return "oak_leaves";
  if (SOLID_SHAPES.has(shape)) return matToBlock(mat);   // walls / natural rock
  if (FLOORISH.has(shape)) return outside ? matToBlock(mat) : "air"; // surface vs dug/cavern
  return "air";
}

/** Fixed offset placing the DF fort inside the MC world; transforms both ways. */
export class Frame {
  constructor(readonly ox: number, readonly oy: number, readonly oz: number) {}
  // DF (x, y, z-level) -> MC (x, y=z, z=y)
  dfToMc(dx: number, dy: number, dz: number): [number, number, number] {
    return [dx + this.ox, dz + this.oy, dy + this.oz];
  }
  mcToDf(mx: number, my: number, mz: number): { x: number; y: number; z: number } {
    return { x: mx - this.ox, y: mz - this.oz, z: my - this.oy };
  }
}
