import { DFHackConnection } from "./dfhack.js";
const df=new DFHackConnection(process.env.DF_HOST??"127.0.0.1",Number(process.env.DF_PORT??5000));
await df.connect();const P="RemoteFortressReader";
const b=await df.bind("SendDigCommand",`${P}.DigCommand`,"dfproto.EmptyMessage",P);
const [x,y,z]=process.argv.slice(2).map(Number);
await df.call(b,{designation:1,locations:[{x,y,z}]});
console.log("dig designated at DF",x,y,z);df.close();
