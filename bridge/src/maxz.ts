import { DFHackConnection } from "./dfhack.js";
const df=new DFHackConnection("127.0.0.1",5000); await df.connect();
const P="RemoteFortressReader";
const bMI=await df.bind("GetMapInfo","dfproto.EmptyMessage",`${P}.MapInfo`,P);
const bB=await df.bind("GetBlockList",`${P}.BlockRequest`,`${P}.BlockList`,P);
const bR=await df.bind("ResetMapHashes","dfproto.EmptyMessage","dfproto.EmptyMessage",P);
const mi=await df.call(bMI); const BX=mi.blockSizeX,BY=mi.blockSizeY,BZ=mi.blockSizeZ;
console.log("map z-levels:",BZ);
await df.call(bR);
let maxSolid=-1, emptyZ=[];
for(let z=0;z<BZ;z++){
  const bl=await df.call(bB,{minX:0,maxX:BX,minY:0,maxY:BY,minZ:z,maxZ:z+1,blocksNeeded:BX*BY*4});
  const n=(bl.mapBlocks??[]).length;
  if(n===0 && z>150) emptyZ.push(z);
  if(n>0) maxSolid=z;
}
console.log("max z with ANY map block:",maxSolid,"(MC y=",maxSolid-64,")");
console.log("empty high z-levels (z>150 with 0 blocks):",emptyZ.slice(0,30).join(","));
df.close();
