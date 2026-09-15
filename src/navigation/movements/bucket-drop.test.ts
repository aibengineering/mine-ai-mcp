import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "../world/memory-world.js";
import { createMovementCatalogue } from "./catalogue.js";
import { createMovementPolicy } from "./policy.js";
import { WELL_FED, planningStart } from "../../test-support/navigation.js";

test("only water-dependent drops receive the bucket movement kind", () => {
  const world = new MemoryWorld();
  for(let x=-2;x<=3;x++)for(let z=-2;z<=2;z++)for(let y=40;y<=50;y++)world.load({x,y,z},{stateId:y===40 || (x===0&&y===46)?1:0});
  const offered=(maximumDrop:number,maximumBucketDrop:number)=>createMovementCatalogue().generate(planningStart({x:0,y:47,z:0}),{world,policy:createMovementPolicy({maximumDrop,maximumBucketDrop,allowDigging:false,allowPlacing:false}),player:WELL_FED},{submergedAtEyes:false,onGround:true,aquaAffinity:false,effects:{}}).toArray().filter(m=>m.to.x===1&&m.to.z===0&&m.to.y===41).map(m=>m.step.kind);
  assert.deepEqual(offered(3,0),[]);
  assert.deepEqual(offered(3,80),["bucket_drop"]);
  assert.deepEqual(offered(8,80),["drop"]);
});
