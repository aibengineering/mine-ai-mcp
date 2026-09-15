import type { BotEvents } from "mineflayer";
import { isThreat } from "../../src/survival/perception/combat/threats.ts";
import { meleeDistance } from "../../src/survival/weapons/melee.ts";
import { hasExposedBody } from "../../src/world/entity-visibility.ts";
import { readEncounters } from "../flat/combat/reflex.ts";
import { prepare as prepareEnd } from "./ender-dragon.ts";
import { openRuntime } from "./runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "./scenario-client.ts";

export const prepare: MineAiScenarioPreparation = async (context) => {
  await prepareEnd(context);
  const { bot } = context;
  bot.chat("/kill @e[type=enderman]");
  // A native hovering dragon keeps the real perch action waiting. This focused
  // ownership test excludes dragon contact so only the Enderman requires defense.
  bot.chat(
    "/data merge entity @e[type=ender_dragon,limit=1] {DragonPhase:10,Pos:[0.0d,120.0d,0.0d],Motion:[0.0d,0.0d,0.0d]}",
  );
  const p = bot.entity.position;
  bot.chat(`/summon enderman ${p.x} ${p.y} ${p.z + 3} {NoAI:1b,PersistenceRequired:1b,Tags:["perch_intruder"]}`);
  await bot.waitForTicks(10);
};

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await using runtime = await openRuntime(context, "dragon-mixed-contact");
  const dragon = bot.nearestEntity((e) => e.name === "ender_dragon");
  const enderman = bot.nearestEntity((e) => e.name === "enderman");
  if (!dragon || !enderman) throw new Error("The native dragon and staged Enderman must both be observed");
  const action = runtime.actions.find((a) => a.name === "attack_dragon_perch")!;
  const stop = new AbortController();
  const joined = AbortSignal.any([signal, stop.signal]);
  const attackers = new Set<number>();
  let contactTicks = 0,
    hitsOnEnderman = 0,
    hitsOnBot = 0,
    targetDied = false,
    died = false;
  let noDefense = false,
    lowestHealth = bot.health;
  const owners: string[] = [];
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source?.id === enderman.id) {
      attackers.add(source.id);
      hitsOnBot++;
    }
    if (entity.id === enderman.id && source?.id === bot.entity.id) hitsOnEnderman++;
  };
  const death: BotEvents["entityDead"] = (entity) => {
    if (entity.id === enderman.id) targetDied = true;
  };
  const botDeath = () => {
    died = true;
  };
  const tick = () => {
    lowestHealth = Math.min(lowestHealth, bot.health);
    const status = runtime.status(),
      owner = `${status.owner}:${status.activeAction?.action ?? "idle"}`;
    if (owners.at(-1) !== owner) {
      owners.push(owner);
      log(`OWNER ${owner}`);
    }
    if (
      isThreat(bot, enderman, { resolvedIds: new Set(), attackerIds: attackers }) &&
      meleeDistance(bot, enderman) <= 3 &&
      hasExposedBody(bot, enderman)
    )
      contactTicks++;
    // Forty exposed melee ticks allow shield readiness and a sword cooldown.
    // Fail promptly on the original bug rather than waiting for the bot to die.
    if (contactTicks >= 40 && hitsOnEnderman === 0) noDefense = true;
  };
  bot.on("entityHurt", hurt);
  bot.on("entityDead", death);
  bot.on("death", botDeath);
  bot.on("physicsTick", tick);
  await bot.waitForTicks(2);
  const perch = runtime.run(action, { entity_id: dragon.id }, joined);
  try {
    await bot.waitForTicks(2);
    if (runtime.status().activeAction?.action !== action.name)
      throw new Error("Perch action was not admitted before contact");
    const admittedRequest = runtime.status().survival.request?.id;
    const uuid = Buffer.from(bot.player.uuid.replaceAll("-", ""), "hex");
    const angryAt = [0, 4, 8, 12].map((offset) => uuid.readInt32BE(offset)).join(",");
    // The final stimulus releases normal native pursuit after the End action
    // owns the body. No further world, mob, damage or inventory commands follow.
    bot.chat(`/data merge entity @e[tag=perch_intruder,limit=1] {NoAI:0b,AngerTime:600,AngryAt:[I;${angryAt}]}`);
    while (!noDefense && !died && (!targetDied || runtime.status().owner !== "foreground")) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await runtime.captureIncident();
    const resumed =
      targetDied &&
      runtime.status().owner === "foreground" &&
      runtime.status().activeAction?.action === action.name &&
      runtime.status().survival.request?.id === admittedRequest;
    stop.abort("Mixed-contact observation complete");
    const output = await perch;
    const encounters = await readEncounters(context, runtime);
    const interrupted = output.interruptions?.some((reason) => reason.startsWith("[HOSTILE_CONTACT]")) ?? false;
    const defended =
      interrupted &&
      resumed &&
      output.result.status === "cancelled" &&
      targetDied &&
      hitsOnEnderman > 0 &&
      !died &&
      encounters.some((e) => e.interrupted?.action === action.name && e.outcome === "target_died");
    return {
      status: defended && !runtime.status().busy ? "succeeded" : "failed",
      detail: JSON.stringify({
        contactTicks,
        hitsOnEnderman,
        hitsOnBot,
        targetDied,
        died,
        noDefense,
        lowestHealth,
        owners,
        output,
        encounters,
        resumed,
      }),
    };
  } finally {
    stop.abort("Mixed-contact scenario finished");
    await perch;
    bot.off("entityHurt", hurt);
    bot.off("entityDead", death);
    bot.off("death", botDeath);
    bot.off("physicsTick", tick);
  }
};
