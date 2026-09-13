// MinecraftEarth — color -> Minecraft block palette mapper (prototype).
//
// Maps an RGB voxel color (sampled from Google Photoreal tile albedo by
// ufo-simulator's mesh-to-sdf) to the nearest Minecraft block id. The output
// ids feed straight into the MDF snapshot palette (Material.matchMaterial()
// resolves them plugin-side). Pure JS, no deps — runnable with `node palette.mjs`.
//
// Palette strategy: a curated set of "solid, full-cube, matte" blocks whose
// average texture color spans the natural + built-world gamut. We deliberately
// prefer concrete (flat, saturated) and terracotta (earthy) over wool (fuzzy),
// plus the obvious naturals (grass/dirt/stone/sand/water). Approximate average
// RGBs for MC 1.21 block textures.

export const BLOCK_PALETTE = [
  // --- naturals (bias the common outdoor colors toward believable blocks) ---
  { id: "grass_block",        rgb: [ 91, 140,  62] },
  { id: "moss_block",         rgb: [ 89, 109,  45] },
  { id: "dirt",               rgb: [134, 96,  67] },
  { id: "coarse_dirt",        rgb: [119, 85,  59] },
  { id: "stone",              rgb: [125, 125, 125] },
  { id: "cobblestone",        rgb: [122, 122, 122] },
  { id: "andesite",           rgb: [136, 136, 137] },
  { id: "gravel",             rgb: [131, 127, 126] },
  { id: "sand",               rgb: [219, 207, 163] },
  { id: "sandstone",          rgb: [216, 203, 157] },
  { id: "water",              rgb: [ 63,  118, 228] },   // decorative; see doc note
  { id: "snow_block",         rgb: [243, 249, 249] },
  { id: "oak_log",            rgb: [107,  84,  47] },
  { id: "oak_planks",         rgb: [162, 131,  79] },
  { id: "mud",                rgb: [ 60,  54,  57] },

  // --- concrete (16) — flat, saturated; the workhorses for built color ---
  { id: "white_concrete",      rgb: [207, 213, 214] },
  { id: "light_gray_concrete", rgb: [125, 125, 115] },
  { id: "gray_concrete",       rgb: [ 55,  58,  62] },
  { id: "black_concrete",      rgb: [  8,  10,  15] },
  { id: "brown_concrete",      rgb: [ 96,  60,  32] },
  { id: "red_concrete",        rgb: [142,  33,  33] },
  { id: "orange_concrete",     rgb: [224, 97,   0] },
  { id: "yellow_concrete",     rgb: [241, 175,  21] },
  { id: "lime_concrete",       rgb: [ 94, 168,  24] },
  { id: "green_concrete",      rgb: [ 73,  91,  36] },
  { id: "cyan_concrete",       rgb: [ 21, 119, 136] },
  { id: "light_blue_concrete", rgb: [ 36, 137, 199] },
  { id: "blue_concrete",       rgb: [ 45,  47, 143] },
  { id: "purple_concrete",     rgb: [100,  32, 156] },
  { id: "magenta_concrete",    rgb: [169,  48, 159] },
  { id: "pink_concrete",       rgb: [213, 101, 142] },

  // --- terracotta (earthy, muted — great for roofs/soil/facades) ---
  { id: "terracotta",              rgb: [152,  94,  67] },
  { id: "white_terracotta",        rgb: [209, 178, 161] },
  { id: "gray_terracotta",         rgb: [ 87,  67,  61] },
  { id: "brown_terracotta",        rgb: [ 77,  51,  35] },
  { id: "red_terracotta",          rgb: [143,  61,  46] },
  { id: "orange_terracotta",       rgb: [162,  84,  38] },
  { id: "yellow_terracotta",       rgb: [186, 133,  35] },
  { id: "light_gray_terracotta",   rgb: [135, 107,  98] },
];

// Redmean perceptual color distance (cheap, better than raw euclidean).
// https://en.wikipedia.org/wiki/Color_difference#sRGB
function colorDist2(a, b) {
  const rmean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (
    (((512 + rmean) * dr * dr) >> 8) +
    4 * dg * dg +
    (((767 - rmean) * db * db) >> 8)
  );
}

/** Nearest block id for an [r,g,b] color. */
export function blockForColor(rgb) {
  let best = BLOCK_PALETTE[0], bestD = Infinity;
  for (const b of BLOCK_PALETTE) {
    const d = colorDist2(rgb, b.rgb);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best.id;
}

// Precomputed 0..255 -> block id map is impractical (16M); callers instead build
// a small palette-index cache keyed on quantized color (see build-snapshot.mjs).

// --- self test -------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = [
    ["forest green",  [ 70, 130,  55], ],
    ["asphalt road",  [ 45,  45,  48], ],
    ["red brick",     [150,  55,  45], ],
    ["concrete gray", [160, 160, 160], ],
    ["beach sand",    [225, 210, 165], ],
    ["deep water",    [ 40,  90, 170], ],
    ["terracotta roof",[170, 80,  45], ],
    ["snow",          [248, 250, 250], ],
    ["dry soil",      [130,  95,  60], ],
    ["glass tower",   [190, 205, 210], ],
  ];
  console.log(`palette size: ${BLOCK_PALETTE.length} blocks\n`);
  for (const [label, rgb] of samples) {
    console.log(`  ${label.padEnd(16)} rgb(${rgb.join(",")}) -> ${blockForColor(rgb)}`);
  }
}
