import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { blockClass, observeMineflayerBlock } from "./world.js";
import { UNLOADED } from "../world/world.js";
import { deferred, nextTurn } from "../../test-support/async.js";
import { type CellReader, worldOf } from "../../test-support/world.js";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
import { decideFootingResponse } from "../../survival/policy/environment.js";
import { bucketAvailable, bucketDropTotals, predictWaterLanding, saveWaterLanding, waterLandingActive, waterableLanding } from "./water-landing.js";
function floor(y: number) {
  const world = new MemoryWorld();
  for (let x = -3; x <= 40; x++)
    for (let z = -3; z <= 10; z++)
      for (let height = y - 1; height <= 150; height++)
        world.load({ x, y: height, z }, { stateId: height === y - 1 ? 1 : 0 });
  return world;
}
test("recorded last End fall gives two ticks warning at y65.1477 above y63", () => {
  const world = floor(63);
  const prediction = predictWaterLanding({ x: 31.323681772084086, y: 65.14768631197818, z: 5.989563027916829 }, { x: -0.19148831448772918, y: -2.0903660598821356, z: -0.006973863590911662 }, world);
  assert.equal(prediction?.ticks, 2);
  assert.deepEqual(prediction?.cell, { x: 30, y: 63, z: 5 });
});
test("water admission rejects partial floors, lava, existing sources and unloaded cells", () => {
  const world = floor(1);
  const cell = { x: 0, y: 1, z: 0 };
  assert.equal(waterableLanding(world, cell), true);
  // A waterloggable floor is the fatal case: leaves pass every other check,
  // then absorb the pour instead of holding a source above them.
  for (const block of [{ stateId: 1, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] }, { stateId: 1, traits: { liquid: "lava" as const } }, { stateId: 1, traits: { damaging: true } }, {stateId: 1, traits: {waterlogged: true}}, {stateId: 1, traits: {waterloggable: true}}, {stateId: 1, traits: {falling: true}}]) {
    world.load({ x: 0, y: 0, z: 0 }, block);
    assert.equal(waterableLanding(world, cell), false);
  }
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 1 });
  world.load(cell, { stateId: 2, collisionShapes: [], traits: { liquid: "water", liquidSource: true } });
  assert.equal(waterableLanding(world, cell), false);
  assert.equal(waterableLanding(world, { x: 90, y: 1, z: 0 }), false);
});
test("bucket rescue precedence reports combat truthfully", () => {
  assert.equal(decideFootingResponse({ combatActive: true, bucketNeeded: true }).kind, "respond");
  assert.equal(decideFootingResponse({ combatActive: true, bucketNeeded: false }).kind, "handled");
});
test("forecast refuses partial ledges and walls touching the body while its centre column is clear", () => {
  const world = floor(1);
  const position = {x:0.75, y:5, z:0.5}, velocity = {x:0,y:-1,z:0};
  assert.ok(predictWaterLanding(position,velocity,world));
  world.load({x:1,y:3,z:0},{stateId:1,collisionShapes:[{minX:0,minY:0,minZ:0,maxX:1,maxY:0.5,maxZ:1}]});
  assert.equal(predictWaterLanding(position,velocity,world),null);
});

test("the body's edge catches a raised full floor before its centre reaches the lower floor", () => {
  const world = floor(1);
  world.load({ x: 1, y: 1, z: 0 }, { stateId: 1 });
  assert.deepEqual(predictWaterLanding({ x: 0.95, y: 5, z: 0.5 }, { x: 0, y: -1, z: 0 }, world)?.cell,
    { x: 1, y: 2, z: 0 });
  // A falling body can step onto a corner entered during horizontal movement.
  assert.deepEqual(predictWaterLanding({ x: 0.5, y: 2.1, z: 0.5 }, { x: 0.5, y: -0.5, z: 0 }, world)?.cell,
    { x: 1, y: 2, z: 0 });
  assert.equal(predictWaterLanding({ x: 0.5, y: 1.6, z: 0.5 }, { x: 0.5, y: -0.5, z: 0 }, world), null,
    "a wall whose top is already above the feet is still refused");
});

test("the recorded eighth-tower diagonal corner gives two ticks to pour", () => {
  const world = floor(61);
  world.load({ x: 15, y: 61, z: -12 }, { stateId: 1 });
  // Expand this fixture's loaded air and lower floor into the recorded Z range.
  for (let x = 14; x <= 18; x++) for (let z = -13; z <= -9; z++)
    for (let y = 60; y <= 100; y++)
      world.load({ x, y, z }, { stateId: y === 60 || (x === 15 && y === 61 && z === -12) ? 1 : 0 });
  const prediction = predictWaterLanding(
    { x: 16.261140129946366, y: 63.99085709970178, z: -10.625247083269196 },
    { x: -0.06087846289653137, y: -1.7610066999476315, z: -0.05201980584702637 }, world);
  assert.equal(prediction?.ticks, 2);
  assert.deepEqual(prediction?.cell, { x: 15, y: 62, z: -12 });
});

test("Nether and unknown dimensions never admit a water bucket", () => {
  for (const dimension of ["the_nether", "custom:void"]) assert.equal(bucketAvailable(botFixture({dimension,items:[{name:"water_bucket",count:1}]})),false);
});

/**
 * A bot falling at `velocityY` with one water bucket in hotbar slot 36, which
 * it holds once selected, over stone at y 0 or over `blocks`. `overrides` adds
 * what the test watches, typically `activateItem`.
 */
function fallingWithBucket(position: Vec3, velocityY: number, overrides: Record<string, unknown> = {}, blocks?: CellReader) {
  const item = { name: "water_bucket", count: 1, slot: 36 };
  const bot = botFixture(
    { items: [item], position, ...(blocks ? { blocks } : { groundY: 0 }) },
    {
      quickBarSlot: 0,
      clearControlStates: () => {},
      deactivateItem: () => {},
      setQuickBarSlot: () => {
        Reflect.set(bot, "heldItem", item);
      },
      ...overrides,
    },
  );
  bot.entity.onGround = false;
  bot.entity.velocity.y = velocityY;
  return { bot, item };
}

/** Cells named in `named` over stone at y 0, where a named water cell is a source a bucket can scoop. */
function sourceWorld() {
  const named: Record<string, string> = {};
  const read = worldOf(named, { groundY: 0 });
  const blocks: CellReader = (cell) => {
    const block = read(cell);
    if (block?.name === "water") block.getProperties = () => ({ level: 0 });
    return block;
  };
  return { named, blocks };
}

/** Server velocity packets are in 1/8000 blocks per tick; 15294 is a relaunch upward. */
function impulse(bot: ReturnType<typeof botFixture>, client: EventEmitter, y: number) {
  client.emit("entity_velocity", { entityId: bot.entity.id, velocity: { y } });
}

test("abort and body resets during one pending storage swap permit no later selection, click or use", async () => {
  for (const event of ["abort", "death", "end", "respawn", "forcedMove", "game"] as const) {
    let clicks = 0, effects = 0;
    const click = deferred();
    const bot = botFixture({ position: new Vec3(0.5, 20, 0.5), items: [{ name: "water_bucket", count: 1, slot:9 }] }, {
      quickBarSlot:0, clickWindow: (slot:number,button:number,mode:number) => {
        assert.deepEqual([slot,button,mode],[9,0,2]); clicks++;
        return click.promise;
      }, activateItem: () => { effects++; }, updateHeldItem: () => {effects++;}, deactivateItem: () => {}, setQuickBarSlot: () => {effects++;}, clearControlStates: () => {}
    });
    const abort = new AbortController();
    const work = saveWaterLanding(bot, { signal: abort.signal, permitted: () => true });
    assert.equal(waterLandingActive(bot), true);
    if (event === "abort") abort.abort(new Error("cancelled"));
    else { if(event === "game") bot.game.dimension="the_nether"; (bot as unknown as EventEmitter).emit(event); }
    await assert.rejects(work);
    assert.equal(waterLandingActive(bot), false);
    click.resolve(); await nextTurn();
    assert.equal(clicks, 1, `${event}: the storage swap was clicked once`);
    assert.equal(effects, 0, `${event}: nothing was selected or used after the reset`);
  }
});

test("revoked policy or a lost reserved bucket stops before the next body effect", async () => {
  for (const loseBucket of [false,true]) {
    const items = [{name:"water_bucket",count:1,slot:36}];
    let permitted = true, controls = 0;
    const bot = botFixture({items,position:new Vec3(.5,20,.5),groundY:0},{quickBarSlot:0,setQuickBarSlot:()=>{},clearControlStates:()=>{},deactivateItem:()=>{},setControlState:()=>{controls++;}});
    const work = saveWaterLanding(bot,{signal:new AbortController().signal,permitted:()=>permitted});
    await nextTurn();
    const before=controls;
    if(loseBucket) items.length=0; else permitted=false;
    bot.emit("physicsTick");
    await assert.rejects(work,/revoked|lost/);
    assert.equal(controls, before, loseBucket ? "a lost bucket drives no control" : "a revoked policy drives no control");
    assert.equal(waterLandingActive(bot),false);
  }
});

test("another full bucket plus removed source cannot falsely prove this attempt recovered its bucket", async () => {
  const items = [{name:"water_bucket",count:1,slot:36},{name:"water_bucket",count:1,slot:37}];
  const { named, blocks } = sourceWorld();
  let uses = 0;
  const bot = botFixture({items,position:new Vec3(.5,2.1,.5),blocks},{quickBarSlot:0,clearControlStates:()=>{},deactivateItem:()=>{},setQuickBarSlot:(slot:number)=>{Reflect.set(bot,"heldItem",items[slot]);},activateItem:()=>{
    uses++;
    if(uses===1) {
      items[0]!.name="bucket"; named["0,1,0"]="water";
      bot.entity.position.y=1; bot.entity.onGround=true; Reflect.set(bot.entity,"isInWater",true);
    } else { delete named["0,1,0"]; }
  }});
  bot.entity.onGround=false; bot.entity.velocity.y=-.65;
  let settled=false;
  const work=saveWaterLanding(bot,{signal:new AbortController().signal,permitted:()=>true}).finally(()=>{settled=true;});
  for(let ticks=0;ticks<250&&!settled;ticks++) {
    await nextTurn(); bot.emit("physicsTick");
  }
  const evidence=await work;
  assert.equal(uses,2); assert.equal(evidence.waterRecovered,false);
  assert.match(evidence.reason??"",/not both observed/);
});

test("native collision-empty fluids and hazards are refused in both feet and head cells", () => {
  for (const height of [1,2]) for (const name of ["water","lava","fire","kelp"]) {
    const bot=botFixture({blocks:{[`0,${height},0`]:name},groundY:0});
    const world={blockAt:(x:number,y:number,z:number)=>{
      const block=bot.blockAt(new Vec3(x,y,z));
      return block?observeMineflayerBlock(block):UNLOADED;
    }};
    assert.equal(waterableLanding(world,{x:0,y:1,z:0}),false,`${name} at ${height}`);
  }
});

test("an unconfirmed pour releases the body promptly after dry impact", async () => {
  const { bot } = fallingWithBucket(new Vec3(.5, 2.1, .5), -.65, {
    activateItem: () => { bot.entity.position.y = 1; bot.entity.onGround = true; },
  });
  let settled=false;
  const work=saveWaterLanding(bot,{signal:new AbortController().signal,permitted:()=>true}).finally(()=>{settled=true;});
  let ticks=0;
  for(;ticks<20&&!settled;ticks++){await nextTurn();bot.emit("physicsTick");}
  const result=await work;
  assert.ok(ticks < 12, `released after ${ticks} ticks`);
  assert.match(result.reason??"",/did not confirm water protection/);
  assert.equal(waterLandingActive(bot),false);
});

test("a slow approach keeps its bucket until the final two forecast ticks", async () => {
  const heights: number[] = [];
  const { bot } = fallingWithBucket(new Vec3(.5, 3.592, .5), -.422, {
    activateItem: () => { heights.push(bot.entity.position.y); },
  });
  const abort = new AbortController();
  const work = saveWaterLanding(bot,{signal:abort.signal,permitted:()=>true});
  await nextTurn();
  assert.deepEqual(heights,[]);
  for(const [height,velocity] of [[3.170,-.492],[2.678,-.560],[2.118,-.627]]) {
    bot.entity.position.y=height!; bot.entity.velocity.y=velocity!;
    bot.emit("physicsTick"); await nextTurn();
    if(height!>2.2) assert.deepEqual(heights, [], `no pour at y ${height}`);
  }
  assert.deepEqual(heights,[2.118]);
  abort.abort(new Error("done")); await assert.rejects(work,/done/);
});

test("cancellation during a relaunch aim prevents a late scoop and releases packet ownership", async () => {
  const { named, blocks } = sourceWorld();
  const client = new EventEmitter();
  const lateAim = deferred();
  let uses=0, aims=0;
  const { bot, item } = fallingWithBucket(new Vec3(.5, 2.1, .5), -.65, {
    _client: client,
    lookAt: () => { aims++; return aims === 1 ? Promise.resolve() : lateAim.promise; },
    activateItem: () => { uses++; item.name = "bucket"; named["0,1,0"] = "water"; },
  }, blocks);
  const abort=new AbortController();
  const work=saveWaterLanding(bot,{signal:abort.signal,permitted:()=>true});
  await nextTurn();
  assert.equal(uses,1);
  impulse(bot, client, 15294);
  assert.equal(aims,2);
  abort.abort(new Error("cancel relaunch"));
  await assert.rejects(work,/cancel relaunch/);
  lateAim.resolve(); await nextTurn();
  assert.equal(uses, 1, "the aim that settles after cancellation scoops nothing");
  assert.equal(waterLandingActive(bot),false);
  assert.equal(client.listenerCount("entity_velocity"),0);
});

for (const verticalImpulse of [15294, -4168])
test(`an impulse before a planned pour redirects its landing: y=${verticalImpulse}`, async () => {
  const client=new EventEmitter();
  const aims: Vec3[]=[];
  let uses=0;
  const { bot } = fallingWithBucket(new Vec3(.5, 20, .5), -.1, {
    _client: client,
    lookAt: (point: Vec3) => { aims.push(point); return Promise.resolve(); },
    activateItem: () => { uses++; },
  });
  const abort=new AbortController();
  const work=saveWaterLanding(bot,{signal:abort.signal,permitted:()=>true,target:{x:0,y:1,z:0}});
  await nextTurn();
  impulse(bot, client, verticalImpulse);
  bot.entity.position.set(10.5,2.1,.5);bot.entity.velocity.set(0,-.65,0);
  bot.emit("physicsTick");await nextTurn();
  assert.equal(uses,1);assert.deepEqual(aims,[new Vec3(10.5,1,.5)]);
  abort.abort(new Error("done"));await assert.rejects(work,/done/);
});

test("a redirected planned drop counts both pours and both independently observed recoveries", async () => {
  const { named, blocks } = sourceWorld();
  const client=new EventEmitter();
  let uses=0;
  const { bot, item } = fallingWithBucket(new Vec3(.5, 2.1, .5), -.65, {
    _client: client,
    activateItem: () => {
      uses++;
      if(uses===1){item.name="bucket";named["0,1,0"]="water";}
      if(uses===2){item.name="water_bucket";delete named["0,1,0"];}
      if(uses===3){item.name="bucket";named["10,1,0"]="water";bot.entity.position.y=1;bot.entity.onGround=true;Reflect.set(bot.entity,"isInWater",true);}
      if(uses===4){item.name="water_bucket";delete named["10,1,0"];}
    },
  }, blocks);
  const abort=new AbortController();
  let settled=false;
  const work=saveWaterLanding(bot,{signal:abort.signal,permitted:()=>true,target:{x:0,y:1,z:0}}).finally(()=>{settled=true;});
  await nextTurn();assert.equal(uses,1);
  impulse(bot, client, 15294);
  await nextTurn();assert.equal(uses,2);
  bot.entity.position.set(10.5,2.1,.5);
  for(let tick=0;tick<20&&!settled;tick++){bot.emit("physicsTick");await nextTurn();}
  if(!settled)abort.abort(new Error("test did not settle"));
  const result=await work;
  assert.equal(uses,4);assert.equal(result.waterRecovered,true);assert.equal(result.relaunchRecoveries,1);
  assert.deepEqual(bucketDropTotals(bot),{count:2,waterRecovered:2});
});

test("a relaunch retains its issued pour when the source arrives seven milliseconds after the launch", async () => {
  for (const inventoryFirst of [true, false]) {
    const { named, blocks } = sourceWorld();
    const client=new EventEmitter();
    let uses=0, recoveries=0;
    const { bot, item } = fallingWithBucket(new Vec3(.5, 2.1, .5), -.65, {
      _client: client,
      activateItem: () => {
        uses++;
        if(uses===1 && inventoryFirst)item.name="bucket";
        if(uses===2){item.name="water_bucket";delete named["0,1,0"];}
      },
    }, blocks);
    const abort=new AbortController();
    const work=saveWaterLanding(bot,{signal:abort.signal,permitted:()=>true,observe:e=>{recoveries=e.relaunchRecoveries;}});
    await nextTurn();assert.equal(uses,1);
    bot.entity.velocity.y=1.91175;
    impulse(bot, client, 15294);
    await new Promise(resolve=>setTimeout(resolve,7));
    assert.equal(waterLandingActive(bot),true);assert.equal(uses,1);
    named["0,1,0"]="water";bot.emit("blockUpdate",null,bot.blockAt(new Vec3(0,1,0))!);
    if(!inventoryFirst){await nextTurn();assert.equal(uses,1);item.name="bucket";bot.emit("heldItemChanged",bot.heldItem);}
    await nextTurn();
    assert.equal(uses,2,"confirmed source is scooped before the next physics displacement");
    bot.emit("physicsTick");await nextTurn();
    assert.equal(recoveries,1);
    abort.abort(new Error("done"));await assert.rejects(work,/done/);
    for(const event of ["blockUpdate","heldItemChanged","move"] as const)assert.equal(bot.listenerCount(event),0,`${event} listener released`);
  }
});

test("pending pour acknowledgment releases listeners on cancellation, lost reach, revoked policy and tick exhaustion", async () => {
  for(const stop of ["abort","move","policy","timeout","no_physics"] as const) {
    const { named, blocks } = sourceWorld();
    const client=new EventEmitter();
    let uses=0, permitted=true;
    const { bot, item } = fallingWithBucket(new Vec3(.5, 2.1, .5), -.65, {
      _client: client,
      activateItem: () => { uses++; item.name = "bucket"; },
    }, blocks);
    const abort=new AbortController();
    let settled=false;
    const work=saveWaterLanding(bot,{signal:abort.signal,permitted:()=>permitted});
    const rejected=assert.rejects(work,stop==="abort"?/cancelled/:stop==="move"?/lost reach/:stop==="policy"?/revoked/:/not acknowledged/).finally(()=>{settled=true;});
    await nextTurn();assert.equal(uses,1);
    impulse(bot, client, 15294);
    assert.equal(bot.listenerCount("blockUpdate"),1);
    if(stop==="abort")abort.abort(new Error("cancelled"));
    if(stop==="move"){bot.entity.position.x=10;bot.emit("move",new Vec3(.5,2.1,.5));}
    if(stop==="policy"){permitted=false;bot.emit("heldItemChanged",bot.heldItem);}
    if(stop!=="no_physics")for(let tick=0;tick<8&&!settled;tick++){await nextTurn();bot.emit("physicsTick");}
    await rejected;
    assert.equal(waterLandingActive(bot),false);assert.equal(client.listenerCount("entity_velocity"),0);
    for(const event of ["blockUpdate","heldItemChanged","move","physicsTick"] as const)assert.equal(bot.listenerCount(event),0,`${stop}: ${event} listener released`);
    named["0,1,0"]="water";bot.emit("blockUpdate",null,bot.blockAt(new Vec3(0,1,0))!);
    await nextTurn();assert.equal(uses, 1, `${stop}: a source arriving afterwards is not scooped`);
  }
});

test("dry oak leaves are refused as a landing floor, and the forecast finds no landing above them", () => {
  const world = floor(1);
  const cell = { x: 0, y: 1, z: 0 };
  assert.equal(waterableLanding(world, cell), true, "the plain floor this fixture builds is landable");
  // The block that killed MineAI_v3 on a planned 32-block bucket drop: a full
  // cube, safe support, not yet waterlogged, and it swallows the poured water.
  const bot = botFixture();
  const leaves = observeMineflayerBlock(
    blockClass(bot).fromStateId(bot.registry.blocksByName.oak_leaves!.defaultState, 0));
  assert.equal(leaves.kind === "loaded" && leaves.traits.waterloggable, true,
    "leaves must be observed as waterloggable before the landing check can refuse them");
  assert.equal(leaves.kind === "loaded" && leaves.traits.waterlogged, false);
  assert.equal(leaves.kind === "loaded" && leaves.geometry.fullCube, true,
    "leaves stop a falling body, which is why every other check admits them");
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 1, traits: { waterloggable: true } });
  assert.equal(waterableLanding(world, cell), false);
  assert.equal(predictWaterLanding({ x: 0.5, y: 33, z: 0.5 }, { x: 0, y: -1, z: 0 }, world), null,
    "a long drop onto a canopy must forecast no landing rather than a pour that cannot work");
});
