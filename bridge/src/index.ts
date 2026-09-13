// MinecraftDwarfFortress bridge.
// Renders a BOUNDED region of the DF fort into Minecraft via a snapshot that the
// plugin turns into a generated world (stable, no artifacts), streams unit
// positions, and turns player breaks into DF dig designations.
// Whole-map rendering overloads the MC server (watchdog -> crash -> missing
// chunks), so we render a window around the fort.

import net from "node:net";
import readline from "node:readline";
import { DFHackConnection, BoundMethod } from "./dfhack.js";
import { blockFor, Frame, TileInfo } from "./mapping.js";

const DF_HOST = process.env.DF_HOST ?? "127.0.0.1";
const DF_PORT = Number(process.env.DF_PORT ?? 5000);
const MC_HOST = process.env.MC_HOST ?? "mc";
const MC_PORT = Number(process.env.MC_PORT ?? 8686);
const W = Number(process.env.RENDER_W ?? 64);        // horizontal half-window (tiles)
const ZD = Number(process.env.RENDER_ZDOWN ?? 48);   // z-levels below surface
const ZU = Number(process.env.RENDER_ZUP ?? 10);     // z-levels above surface
const SURFACE_Y = Number(process.env.SURFACE_Y ?? 100);
const UNIT_MS = Number(process.env.UNIT_MS ?? 1000);
const RERENDER_MS = Number(process.env.RERENDER_MS ?? 5000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[bridge]", ...a);

async function connectDF(): Promise<DFHackConnection> {
  for (let i = 1; ; i++) {
    const c = new DFHackConnection(DF_HOST, DF_PORT);
    try { await c.connect(); log(`connected to DFHack ${DF_HOST}:${DF_PORT}`); return c; }
    catch (e) { c.close(); log(`DF not ready (${(e as Error).message}); retry`); await sleep(Math.min(15000, i * 2000)); }
  }
}

async function main() {
  const df = await connectDF();
  const P = "RemoteFortressReader";
  const bMapInfo = await df.bind("GetMapInfo", "dfproto.EmptyMessage", `${P}.MapInfo`, P);
  const bUnits = await df.bind("GetUnitList", "dfproto.EmptyMessage", `${P}.UnitList`, P);
  const bTiletypes = await df.bind("GetTiletypeList", "dfproto.EmptyMessage", `${P}.TiletypeList`, P);
  const bBlocks = await df.bind("GetBlockList", `${P}.BlockRequest`, `${P}.BlockList`, P);
  const bReset = await df.bind("ResetMapHashes", "dfproto.EmptyMessage", "dfproto.EmptyMessage", P);
  const bDig = await df.bind("SendDigCommand", `${P}.DigCommand`, "dfproto.EmptyMessage", P);

  while (true) {
    try { const m = await df.call(bMapInfo); if (m.blockSizeX) break; } catch { /* no fort */ }
    log("waiting for a fort to load…"); await sleep(3000);
  }

  const ttList = await df.call(bTiletypes);
  const tt = new Map<number, TileInfo>();
  for (const t of ttList.tiletypeList ?? []) tt.set(t.id, { shape: t.shape ?? -1, material: t.material ?? -1 });
  log(`tiletype table: ${tt.size} entries`);

  const mi = await df.call(bMapInfo);
  const BX = mi.blockSizeX ?? 12, BY = mi.blockSizeY ?? 12, BZ = mi.blockSizeZ ?? 187;
  const MAPX = BX * 16, MAPY = BY * 16;

  // centre on the surface embark group
  const first = await df.call(bUnits);
  const onMap = (first.creatureList ?? []).filter((u: any) => u.posX != null);
  if (!onMap.length) throw new Error("no on-map units");
  const surfaceZ = Math.max(...onMap.map((u: any) => u.posZ));
  const surface = onMap.filter((u: any) => u.posZ >= surfaceZ - 3);
  const cx = Math.round(surface.reduce((s: number, u: any) => s + u.posX, 0) / surface.length);
  const cy = Math.round(surface.reduce((s: number, u: any) => s + u.posY, 0) / surface.length);
  const cz = surfaceZ;

  // bounded window (tile coords, clamped to the map)
  const WX0 = Math.max(0, cx - W), WX1 = Math.min(MAPX - 1, cx + W);
  const WY0 = Math.max(0, cy - W), WY1 = Math.min(MAPY - 1, cy + W);
  const WZ0 = Math.max(0, cz - ZD), WZ1 = BZ - 1;   // include everything up to the map top (no vertical cut)
  const sx = WX1 - WX0 + 1, sy = WY1 - WY0 + 1, sz = WZ1 - WZ0 + 1;

  // frame: DF -> MC (units/dig). fort centre -> MC (0,*,0); surface -> MC y=SURFACE_Y.
  const frame = new Frame(-cx, SURFACE_Y - cz, -cy);
  // generator offsets: MC world coord -> snapshot LOCAL index (dfx=wx-ox etc.)
  const gox = WX0 - cx, goy = SURFACE_Y - cz + WZ0, goz = WY0 - cy;
  log(`fort centre (${cx},${cy},${cz}); window ${sx}x${sy}x${sz} (~${(sx * sy * sz / 1e6).toFixed(1)}M cells); surface at MC y=${SURFACE_Y}`);

  // ---- MC connection (reconnecting) --------------------------------------
  let mc: net.Socket | null = null;
  const send = (o: unknown) => { if (mc && !mc.destroyed) mc.write(JSON.stringify(o) + "\n"); };

  const snapshot = new Uint8Array(sx * sy * sz);   // palette index per window tile (0 = air)
  const paletteIndex = new Map<string, number>([["air", 0]]);
  const paletteArr: string[] = ["air"];
  const palId = (name: string) => {
    let i = paletteIndex.get(name);
    if (i === undefined) { i = paletteArr.length; paletteIndex.set(name, i); paletteArr.push(name); }
    return i;
  };

  const buildSnapshot = async () => {
    await df.call(bReset);
    snapshot.fill(0);
    let solid = 0;
    const minBX = Math.floor(WX0 / 16), maxBX = Math.floor(WX1 / 16) + 1;
    const minBY = Math.floor(WY0 / 16), maxBY = Math.floor(WY1 / 16) + 1;
    for (let z = WZ0; z <= WZ1; z++) {
      // retry empty/failed reads so no layer is silently dropped
      let bl: any = { mapBlocks: [] };
      for (let tries = 0; tries < 4; tries++) {
        try { bl = await df.call(bBlocks, { minX: minBX, maxX: maxBX, minY: minBY, maxY: maxBY, minZ: z, maxZ: z + 1, blocksNeeded: (maxBX - minBX) * (maxBY - minBY) * 2 }); }
        catch { bl = { mapBlocks: [] }; }
        if ((bl.mapBlocks?.length ?? 0) > 0) break;
        await sleep(50);
      }
      for (const b of bl.mapBlocks ?? []) {
        const tiles = b.tiles ?? [], outside = b.outside ?? [], magma = b.magma ?? [], water = b.water ?? [];
        for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) {
          const tx = b.mapX + lx, ty = b.mapY + ly, tz = b.mapZ;
          if (tx < WX0 || tx > WX1 || ty < WY0 || ty > WY1) continue;
          const blk = blockFor(tt, tiles[lx * 16 + ly] ?? 0, magma[lx * 16 + ly] ?? 0, water[lx * 16 + ly] ?? 0, outside[lx * 16 + ly] ?? false);
          if (blk === null || blk === "air") continue;
          snapshot[((tx - WX0) * sy + (ty - WY0)) * sz + (tz - WZ0)] = palId(blk);
          solid++;
        }
      }
    }
    return solid;
  };

  const sendSnapshot = () => {
    send({ t: "snap_begin", sx, sy, sz, ox: gox, oy: goy, oz: goz, total: snapshot.length, palette: paletteArr });
    const CHUNK = 48000;
    for (let off = 0; off < snapshot.length; off += CHUNK) {
      send({ t: "snap", off, data: Buffer.from(snapshot.subarray(off, Math.min(off + CHUNK, snapshot.length))).toString("base64") });
    }
    send({ t: "snap_end" });
  };

  const pushUnits = async () => {
    try {
      const u = await df.call(bUnits);
      const list: unknown[] = [];
      for (const c of u.creatureList ?? []) {
        if (c.posX == null) continue;
        if (c.posX < WX0 || c.posX > WX1 || c.posY < WY0 || c.posY > WY1) continue; // in-window
        const [mx, my, mz] = frame.dfToMc(c.posX, c.posY, c.posZ);
        list.push({ id: c.id, x: mx, y: my + 1, z: mz, name: c.name || "dwarf" });
      }
      send({ t: "units", list });
    } catch (e) { log("unit push error:", (e as Error).message); }
  };

  // live diff (optional; off by default for stability). Scoped to the window.
  const liveDiff = async () => {
    const bl = await df.call(bBlocks, {
      minX: Math.floor(WX0 / 16), maxX: Math.floor(WX1 / 16) + 1,
      minY: Math.floor(WY0 / 16), maxY: Math.floor(WY1 / 16) + 1,
      minZ: WZ0, maxZ: WZ1 + 1, blocksNeeded: 8192,
    });
    let batch: unknown[] = [];
    const flush = () => { if (batch.length) { send({ t: "blocks", cells: batch }); batch = []; } };
    for (const b of bl.mapBlocks ?? []) {
      const tiles = b.tiles ?? [], outside = b.outside ?? [], magma = b.magma ?? [], water = b.water ?? [];
      for (let lx = 0; lx < 16; lx++) for (let ly = 0; ly < 16; ly++) {
        const tx = b.mapX + lx, ty = b.mapY + ly, tz = b.mapZ;
        if (tx < WX0 || tx > WX1 || ty < WY0 || ty > WY1) continue;
        const blk = blockFor(tt, tiles[lx * 16 + ly] ?? 0, magma[lx * 16 + ly] ?? 0, water[lx * 16 + ly] ?? 0, outside[lx * 16 + ly] ?? false);
        if (blk === null) continue;
        const [mx, my, mz] = frame.dfToMc(tx, ty, tz);
        batch.push([mx, my, mz, blk]);
        if (batch.length >= 2000) flush();
      }
    }
    flush();
  };

  const handleLine = async (line: string) => {
    if (!line.trim()) return;
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    if (msg.t === "break") {
      const d = frame.mcToDf(msg.x, msg.y, msg.z);
      try {
        await df.call(bDig, { designation: 1, locations: [{ x: d.x, y: d.y, z: d.z }] });
        log(`dig designated at DF (${d.x},${d.y},${d.z})`);
      } catch (e) { log("dig error:", (e as Error).message); }
    }
  };

  const setupMC = async () => {
    for (;;) {
      try {
        const s = net.connect(MC_PORT, MC_HOST);
        await new Promise<void>((res, rej) => { s.once("connect", () => res()); s.once("error", rej); });
        mc = s;
        log(`connected to MC plugin ${MC_HOST}:${MC_PORT}`);
        const rl = readline.createInterface({ input: s });
        rl.on("line", handleLine);
        s.on("error", () => {});
        s.on("close", () => { log("MC disconnected; reconnecting…"); mc = null; rl.close(); setTimeout(setupMC, 3000); });
        const solid = await buildSnapshot();
        log(`snapshot: ${solid} solid cells, palette ${paletteArr.length}; sending…`);
        sendSnapshot();
        send({ t: "spawn", x: 0, y: SURFACE_Y + 2, z: 0 });
        await pushUnits();
        log("snapshot sent; plugin generates the 'dffort' world.");
        return;
      } catch (e) { log(`MC not ready (${(e as Error).message}); retry`); await sleep(3000); }
    }
  };
  await setupMC();

  setInterval(pushUnits, UNIT_MS);
  if (process.env.LIVE_DIFF === "1") {
    setInterval(() => { liveDiff().catch((e) => log("live-diff error:", (e as Error).message)); }, RERENDER_MS);
    log(`live-diff ON @${RERENDER_MS}ms`);
  } else {
    log("live-diff OFF (stable static terrain); units still update. Set LIVE_DIFF=1 to enable.");
  }
  log(`units@${UNIT_MS}ms. Join 'dffort' at MC (0, ~${SURFACE_Y}, 0).`);
}

main().catch((e) => { console.error("[bridge] fatal:", e); process.exit(1); });
