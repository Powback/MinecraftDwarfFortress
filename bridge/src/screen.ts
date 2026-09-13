// Headless DF screen driver over RemoteFortressReader: read the screen (CopyScreen)
// and inject keystrokes (PassKeyboardEvent). Lets us drive worldgen + embark
// programmatically, no VNC. SDL 1.2 event semantics (DF 0.47.05).
//
// Usage (run inside the bridge container, which shares DF's netns → 127.0.0.1):
//   npx tsx src/screen.ts dump                 # print the current screen as text
//   npx tsx src/screen.ts key DOWN DOWN ENTER  # send keys (names or single chars)
//   npx tsx src/screen.ts keydump e wait:2 ENTER   # send keys, wait, then dump
// wait:<seconds> pauses between keys (worldgen needs time).

import { DFHackConnection, BoundMethod } from "./dfhack.js";

const HOST = process.env.DF_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DF_PORT ?? 5000);

const SDL_KEYDOWN = 2, SDL_KEYUP = 3, SDL_PRESSED = 1, SDL_RELEASED = 0;

// SDL 1.2 keysym values for named keys.
const NAMED: Record<string, number> = {
  ENTER: 13, RETURN: 13, ESC: 27, ESCAPE: 27, SPACE: 32, TAB: 9, BACKSPACE: 8,
  UP: 273, DOWN: 274, RIGHT: 275, LEFT: 276,
  PLUS: 61, MINUS: 45,
};

function keysym(name: string): { sym: number; uni: number } {
  const up = name.toUpperCase();
  if (up in NAMED) return { sym: NAMED[up], uni: up === "ENTER" || up === "RETURN" ? 13 : (NAMED[up] < 128 ? NAMED[up] : 0) };
  if (name.length === 1) {
    const c = name.charCodeAt(0);
    // sym is lowercase for letters; unicode carries the actual char
    const sym = c >= 65 && c <= 90 ? c + 32 : c;
    return { sym, uni: c };
  }
  throw new Error(`unknown key: ${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendKey(conn: DFHackConnection, pass: BoundMethod, name: string) {
  const { sym, uni } = keysym(name);
  await conn.call(pass, { type: SDL_KEYDOWN, state: SDL_PRESSED, sym, mod: 0, scancode: 0, unicode: uni });
  await conn.call(pass, { type: SDL_KEYUP, state: SDL_RELEASED, sym, mod: 0, scancode: 0, unicode: uni });
}

async function dump(conn: DFHackConnection, copy: BoundMethod) {
  const s = await conn.call(copy);
  const w = s.width ?? 0, h = s.height ?? 0;
  const tiles = s.tiles ?? [];
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const t = tiles[x * h + y];          // column-major
      const ch = t?.character ?? 32;
      line += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : (ch === 0 ? " " : "·");
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  console.log(`===== DF screen ${w}x${h} =====`);
  console.log(rows.join("\n").replace(/\n{3,}/g, "\n\n"));
  console.log(`===== end screen =====`);
}

async function main() {
  const conn = new DFHackConnection(HOST, PORT);
  await conn.connect();
  const P = "RemoteFortressReader";
  const copy = await conn.bind("CopyScreen", "dfproto.EmptyMessage", `${P}.ScreenCapture`, P);
  const pass = await conn.bind("PassKeyboardEvent", `${P}.KeyboardEvent`, "dfproto.EmptyMessage", P);

  const [cmd, ...rest] = process.argv.slice(2);

  const runKeys = async (keys: string[]) => {
    for (const k of keys) {
      if (k.startsWith("wait:")) { await sleep(Number(k.slice(5)) * 1000); continue; }
      await sendKey(conn, pass, k);
      await sleep(180);
    }
  };

  if (cmd === "dump") {
    await dump(conn, copy);
  } else if (cmd === "key") {
    await runKeys(rest);
  } else if (cmd === "keydump") {
    await runKeys(rest);
    await sleep(500);
    await dump(conn, copy);
  } else {
    console.log("usage: dump | key <keys...> | keydump <keys...>");
  }
  conn.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
