// Run a DFHack console command over RPC (core RunCommand). e.g. `cmd reveal`.
import { DFHackConnection } from "./dfhack.js";
const df = new DFHackConnection(process.env.DF_HOST ?? "127.0.0.1", Number(process.env.DF_PORT ?? 5000));
await df.connect();
const b = await df.bind("RunCommand", "dfproto.CoreRunCommandRequest", "dfproto.EmptyMessage"); // no plugin -> core
const [command, ...args] = process.argv.slice(2);
await df.call(b, { command, arguments: args });
console.log("ran DFHack command:", command, args.join(" "));
df.close();
