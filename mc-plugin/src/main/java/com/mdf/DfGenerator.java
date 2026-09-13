package com.mdf;

import org.bukkit.Material;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.generator.WorldInfo;

import java.util.Random;

/**
 * Generates the Minecraft world directly from a cached DF map snapshot, so chunks
 * arrive as correct full-chunk packets when the client loads them (proper lighting,
 * no incremental-edit artifacts). Live changes (digging) are applied on top as small
 * block edits. See DESIGN.md §8/§9.
 *
 * Frame (matches the bridge): mc = (dfx+ox, dfz+oy, dfy+oz); inverse used here.
 */
public class DfGenerator extends ChunkGenerator {
    private final byte[] snap;                 // palette index per DF tile
    private final int sx, sy, sz;              // DF map dims (tiles)
    private final int ox, oy, oz;              // MC offset
    private final Material[] palette;          // palette index -> Material (index 0 = air)

    public DfGenerator(byte[] snap, int sx, int sy, int sz, int ox, int oy, int oz, Material[] palette) {
        this.snap = snap; this.sx = sx; this.sy = sy; this.sz = sz;
        this.ox = ox; this.oy = oy; this.oz = oz; this.palette = palette;
    }

    @Override
    public void generateNoise(WorldInfo worldInfo, Random random, int chunkX, int chunkZ, ChunkData data) {
        final int baseX = chunkX << 4, baseZ = chunkZ << 4;
        final int yMin = Math.max(data.getMinHeight(), oy);          // dfz = 0
        final int yMax = Math.min(data.getMaxHeight() - 1, oy + sz - 1); // dfz = sz-1
        for (int lx = 0; lx < 16; lx++) {
            int dfx = baseX + lx - ox;
            if (dfx < 0 || dfx >= sx) continue;
            for (int lz = 0; lz < 16; lz++) {
                int dfy = baseZ + lz - oz;
                if (dfy < 0 || dfy >= sy) continue;
                int col = (dfx * sy + dfy) * sz;
                for (int wy = yMin; wy <= yMax; wy++) {
                    int dfz = wy - oy;
                    int pi = snap[col + dfz] & 0xff;
                    if (pi == 0) continue;                           // air
                    Material m = palette[pi];
                    if (m != null && m != Material.AIR) data.setBlock(lx, wy, lz, m);
                }
            }
        }
    }

    // Only our blocks — no vanilla terrain/features.
    @Override public boolean shouldGenerateNoise() { return false; }
    @Override public boolean shouldGenerateSurface() { return false; }
    @Override public boolean shouldGenerateCaves() { return false; }
    @Override public boolean shouldGenerateDecorations() { return false; }
    @Override public boolean shouldGenerateMobs() { return false; }
    @Override public boolean shouldGenerateStructures() { return false; }
}
