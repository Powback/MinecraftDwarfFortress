// Minimal DFHack remote-protocol client (TCP) for RemoteFortressReader.
//
// Wire protocol (see DFHack RemoteClient / RemoteServer):
//   Handshake  : client sends  magic[8]="DFHack?\n" + int32 version(=1)
//                server replies magic[8]="DFHack!\n" + int32 version
//   Message    : header = int16 id, 2 bytes pad, int32 size  (8 bytes, little-endian)
//                followed by `size` bytes of protobuf body
//   To call a plugin method you first BIND it (id 0, CoreBindRequest -> CoreBindReply)
//   to get an assigned id, then call that id with the method's input message.
//   Reply header ids: RESULT(-1) carries the output body, FAIL(-2) carries a result
//   code in the size field (no body), TEXT(-3) is a console notification.
//
// This is the Stage-0 spike: if the heartbeat prints a map + unit count, the whole
// DF->bridge data path is proven.

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

const REQUEST_MAGIC = "DFHack?\n";
const RESPONSE_MAGIC = "DFHack!\n";
const PROTOCOL_VERSION = 1;

const BIND_METHOD_ID = 0;
const RPC_REPLY_RESULT = -1;
const RPC_REPLY_FAIL = -2;
const RPC_REPLY_TEXT = -3;

const HEADER_SIZE = 8;

const PROTO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../proto",
);

export interface BoundMethod {
  id: number;
  input: protobuf.Type;
  output: protobuf.Type;
}

export class DFHackConnection {
  private sock = new net.Socket();
  private buf: Buffer = Buffer.alloc(0);
  private waiter: { need: number; resolve: (b: Buffer) => void } | null = null;
  private root!: protobuf.Root;
  // serialize RPC calls: DFHack handles one request/reply at a time per connection
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private host: string,
    private port: number,
  ) {}

  // ---- low-level framing -------------------------------------------------

  private pump() {
    if (this.waiter && this.buf.length >= this.waiter.need) {
      const { need, resolve } = this.waiter;
      const out = Buffer.from(this.buf.subarray(0, need));
      this.buf = this.buf.subarray(need);
      this.waiter = null;
      resolve(out);
    }
  }

  private readExact(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve) => {
      this.waiter = { need: n, resolve };
      this.pump();
    });
  }

  private write(buf: Buffer): void {
    this.sock.write(buf);
  }

  private sendMessage(id: number, body: Uint8Array): void {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeInt16LE(id, 0);
    header.writeInt32LE(body.length, 4);
    this.write(Buffer.concat([header, Buffer.from(body)]));
  }

  // Read frames until a RESULT or FAIL; TEXT frames are logged and skipped.
  private async readReply(): Promise<{ ok: true; body: Buffer } | { ok: false; code: number }> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const header = await this.readExact(HEADER_SIZE);
      const id = header.readInt16LE(0);
      const size = header.readInt32LE(4);

      if (id === RPC_REPLY_FAIL) {
        return { ok: false, code: size }; // size field carries the command_result
      }
      if (id === RPC_REPLY_TEXT) {
        const body = await this.readExact(size);
        try {
          const note = this.root
            .lookupType("dfproto.CoreTextNotification")
            .decode(body) as any;
          for (const frag of note.fragments ?? []) {
            if (frag.text) console.log(`  [df] ${frag.text}`);
          }
        } catch {
          /* ignore malformed text notifications */
        }
        continue;
      }
      if (id === RPC_REPLY_RESULT) {
        const body = await this.readExact(size);
        return { ok: true, body };
      }
      // Unknown/unexpected frame: drain its body and keep going.
      await this.readExact(Math.max(0, size));
    }
  }

  // ---- connection + handshake -------------------------------------------

  async connect(): Promise<void> {
    this.root = await protobuf.load([
      path.join(PROTO_DIR, "CoreProtocol.proto"),
      path.join(PROTO_DIR, "RemoteFortressReader.proto"),
    ]);

    await new Promise<void>((resolve, reject) => {
      this.sock.once("error", reject);
      this.sock.connect(this.port, this.host, () => {
        this.sock.off("error", reject);
        resolve();
      });
    });
    this.sock.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    });

    // handshake
    const req = Buffer.alloc(12);
    req.write(REQUEST_MAGIC, 0, "ascii");
    req.writeInt32LE(PROTOCOL_VERSION, 8);
    this.write(req);

    const resp = await this.readExact(12);
    const magic = resp.toString("ascii", 0, 8);
    if (magic !== RESPONSE_MAGIC) {
      throw new Error(`bad DFHack handshake magic: ${JSON.stringify(magic)}`);
    }
  }

  // ---- RPC ---------------------------------------------------------------

  /** Bind a plugin method, returning an id + its protobuf types. */
  async bind(
    method: string,
    inputType: string,
    outputType: string,
    plugin?: string,
  ): Promise<BoundMethod> {
    return this.enqueue(async () => {
      const CoreBindRequest = this.root.lookupType("dfproto.CoreBindRequest");
      const CoreBindReply = this.root.lookupType("dfproto.CoreBindReply");
      const body = CoreBindRequest.encode(
        CoreBindRequest.create({
          method,
          inputMsg: inputType,
          outputMsg: outputType,
          plugin,
        }),
      ).finish();
      this.sendMessage(BIND_METHOD_ID, body);
      const reply = await this.readReply();
      if (!reply.ok) throw new Error(`bind ${method} failed (code ${reply.code})`);
      const decoded = CoreBindReply.decode(reply.body) as any;
      return {
        id: decoded.assignedId,
        input: this.root.lookupType(inputType),
        output: this.root.lookupType(outputType),
      };
    });
  }

  /** Call a bound method with a plain-object input; returns decoded output. */
  async call(m: BoundMethod, input: Record<string, unknown> = {}): Promise<any> {
    return this.enqueue(async () => {
      const body = m.input.encode(m.input.create(input)).finish();
      this.sendMessage(m.id, body);
      const reply = await this.readReply();
      if (!reply.ok) throw new Error(`call id ${m.id} failed (code ${reply.code})`);
      return m.output.decode(reply.body);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // keep the chain alive even if a call rejects
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    try {
      this.sock.destroy();
    } catch {
      /* noop */
    }
  }
}

/** RemoteFortressReader convenience wrapper — binds the Stage-0 methods. */
export class FortressReader {
  private getVersionInfo!: BoundMethod;
  private getMapInfo!: BoundMethod;
  private getUnitList!: BoundMethod;

  constructor(private conn: DFHackConnection) {}

  async bindAll(): Promise<void> {
    const P = "RemoteFortressReader";
    this.getVersionInfo = await this.conn.bind(
      "GetVersionInfo", "dfproto.EmptyMessage", `${P}.VersionInfo`, P,
    );
    this.getMapInfo = await this.conn.bind(
      "GetMapInfo", "dfproto.EmptyMessage", `${P}.MapInfo`, P,
    );
    this.getUnitList = await this.conn.bind(
      "GetUnitList", "dfproto.EmptyMessage", `${P}.UnitList`, P,
    );
  }

  versionInfo() {
    return this.conn.call(this.getVersionInfo);
  }
  mapInfo() {
    return this.conn.call(this.getMapInfo);
  }
  unitList() {
    return this.conn.call(this.getUnitList);
  }
}
