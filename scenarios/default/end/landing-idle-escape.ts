import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Vec3 } from "vec3";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";
import { dragonDanger, readDragonClouds } from "../../../src/world/dragon-hazards.ts";
import { dragonPhase, observedDragonLandingCenter } from "../../../src/world/end-fight.ts";
import { damageSourceName } from "../../../src/world/damage-registry.ts";

// Recorded idle-bot death, seed 64510673: a curved landing repeatedly made
// the linear escape prediction declare cells beneath the arriving wings safe.
const start = new Vec3(-1.5005339895, 65, 3.5410921273);
const dragonStart = new Vec3(6.3562760472, 77.4175431549, -3.9749171007);

export const prepare: MineAiScenarioPreparation = async context => {
  const { bot, signal } = context;
  await wearArmor(context);
  for (let t=0;t<400 && !bot.nearestEntity(e=>e.name==="ender_dragon");t++) {
    signal.throwIfAborted(); await bot.waitForTicks(1);
  }
  bot.chat(`/data merge entity @e[type=ender_dragon,limit=1] {NoAI:1b,DragonPhase:3,Pos:[${dragonStart.x}d,${dragonStart.y}d,${dragonStart.z}d],Motion:[0d,0d,0d],Rotation:[-95.625f,0f]}`);
  bot.chat('/kill @e[type=enderman]');
  bot.chat('/execute as @e[type=end_crystal] unless entity @s[x=33.5,y=80,z=-24.5,distance=..1] unless entity @s[x=-33.5,y=83,z=-24.5,distance=..1] run kill @s');
  bot.chat('/summon area_effect_cloud -0.7701180636 65 11.637067192 {Radius:4.0f,Duration:600,WaitTime:20,RadiusPerTick:0.006666667f,Particle:{type:"minecraft:dragon_breath"},effects:[{id:"minecraft:instant_damage",amplifier:1b,duration:1}]}');
  bot.chat(`/tp @s ${start.x} ${start.y} ${start.z}`);
  await bot.waitForTicks(10);
  const dragon = bot.nearestEntity(e=>e.name==="ender_dragon");
  const center = observedDragonLandingCenter(bot);
  if (!dragon || dragon.position.distanceTo(dragonStart)>0.3 || dragonPhase(bot,dragon)!==3 ||
      bot.entity.position.distanceTo(start)>0.1 || !bot.entity.onGround || bot.health!==20 ||
      !center || readDragonClouds(bot).length!==1) throw new Error("Recorded landing scene was not acknowledged");
  context.log(JSON.stringify({ staged: { bot:bot.entity.position, dragon:dragon.position, center, clouds:readDragonClouds(bot) } }));
};

export const run: MineAiScenario = async context => {
  await recordSourceIdentity();
  const { bot } = context;
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
  copyFileSync(fileURLToPath(import.meta.url),path.join(artifacts,"landing-escape.ts"));
  await using runtime = await openRuntime(context,"landing-idle-escape");
  let ticks=0, lowestHealth=bot.health, deaths=0, reflexTicks=0, settledSeen=false, landingContacts=0;
  const phases = new Set<number|null>();
  const hits: unknown[]=[];
  const tick=()=>{
    ticks++; lowestHealth=Math.min(lowestHealth,bot.health);
    const dragon=bot.nearestEntity(e=>e.name==="ender_dragon");
    const phase=dragon ? dragonPhase(bot,dragon) : null;
    phases.add(phase); if (phase===5 || phase===6 || phase===7) settledSeen=true;
    const status=runtime.status(); if (status.owner==="takeover") reflexTicks++;
    appendFileSync(path.join(artifacts,"landing-physics.jsonl"),JSON.stringify({tick:ticks,position:bot.entity.position,health:bot.health,food:bot.food,danger:dragonDanger(bot),phase,dragon:dragon?.position,status})+"\n");
  };
  const death=()=>{ deaths++; };
  const hit=(packet:{entityId:number;sourceTypeId:number})=>{
    if(packet.entityId!==bot.entity.id) return;
    const source=damageSourceName(bot,packet.sourceTypeId);
    if(source==="minecraft:mob_attack" && !settledSeen) landingContacts++;
    hits.push({tick:ticks,source,position:bot.entity.position.clone(),health:bot.health});
  };
  bot.on("physicsTick",tick); bot.on("death",death); bot._client.on("damage_event",hit);
  try {
    // Only setup release is commanded. The native dragon then lands freely;
    // an idle production runtime owns every movement and survival response.
    bot.chat('/data merge entity @e[type=ender_dragon,limit=1] {NoAI:0b,DragonPhase:3,Motion:[-0.0435d,-0.146d,0.010875d]}');
    while(ticks<400 && !deaths) { context.signal.throwIfAborted(); await bot.waitForTicks(1); }
    const result={passed:deaths===0 && landingContacts===0 && lowestHealth>=12 && settledSeen && reflexTicks>0 && !dragonDanger(bot),deaths,lowestHealth,landingContacts,reflexTicks,settledSeen,phases:[...phases],hits,position:bot.entity.position,health:bot.health};
    writeFileSync(path.join(artifacts,"landing-result.json"),JSON.stringify(result,null,2));
    return {status:result.passed ? "succeeded" : "failed",detail:JSON.stringify(result)};
  } finally { bot.off("physicsTick",tick); bot.off("death",death); bot._client.off("damage_event",hit); }
};
