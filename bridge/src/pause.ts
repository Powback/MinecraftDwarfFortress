import { DFHackConnection } from "./dfhack.js";
const df=new DFHackConnection(process.env.DF_HOST??"127.0.0.1",Number(process.env.DF_PORT??5000));
await df.connect();const P="RemoteFortressReader";
const b=await df.bind("SetPauseState",`${P}.SingleBool`,"dfproto.EmptyMessage",P);
await df.call(b,{value:true});console.log("paused");df.close();
