import { DFHackConnection } from "./dfhack.js";
const df=new DFHackConnection("127.0.0.1",5000); await df.connect();
const P="RemoteFortressReader";
const bTT=await df.bind("GetTiletypeList","dfproto.EmptyMessage",`${P}.TiletypeList`,P);
const bMI=await df.bind("GetMapInfo","dfproto.EmptyMessage",`${P}.MapInfo`,P);
const bB=await df.bind("GetBlockList",`${P}.BlockRequest`,`${P}.BlockList`,P);
const bR=await df.bind("ResetMapHashes","dfproto.EmptyMessage","dfproto.EmptyMessage",P);
const tt=new Map(); for(const t of (await df.call(bTT)).tiletypeList??[]) tt.set(t.id,{shape:t.shape??-1});
const SOLID=new Set([2,3,4,5]); // wall-ish shapes
const mi=await df.call(bMI); const BX=mi.blockSizeX,BY=mi.blockSizeY,BZ=mi.blockSizeZ;
await df.call(bR);
for(let z=BZ-1;z>=160;z--){
  const bl=await df.call(bB,{minX:0,maxX:BX,minY:0,maxY:BY,minZ:z,maxZ:z+1,blocksNeeded:BX*BY*4});
  let solid=0,floorOutside=0;
  for(const b of bl.mapBlocks??[]){const tiles=b.tiles??[],out=b.outside??[];
    for(let i=0;i<tiles.length;i++){const info=tt.get(tiles[i]); if(!info)continue;
      if(SOLID.has(info.shape))solid++; else if(info.shape===1&&out[i])floorOutside++;}}
  if(solid+floorOutside>0) console.log(`z=${z} (y=${z-64}): wall=${solid} surfaceFloor=${floorOutside}`);
}
df.close();
