import { z } from "zod";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { hurt, readEncounters } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  const died = new AbortController();
  const onDeath = () => died.abort(new Error("Wounded bot died"));
  const signal = AbortSignal.any([context.signal, died.signal]);
  const { mob, protection, burning, startingHealth } = z
    .object({
      mob: z.enum(["blaze", "skeleton"]),
      burning: z.boolean().default(false),
      protection: z.enum(["buildable", "unbuildable"]).default("buildable"),
      startingHealth: z.number().min(1).max(19).default(10),
    })
    .parse(context.scenario.params);
  await wearArmor(context);
  // Freeze recovery only during arrangement, so the admitted response starts
  // in the observed eight-to-twelve-health gap. No teleport or healing in combat.
  bot.chat("/gamerule naturalRegeneration false");
  if (burning) {
    // A native lava touch leaves a long burn after escape. The shield cannot
    // block these residual ticks, which killed the equipped eyes trial.
    bot.chat("/setblock 0 -60 0 lava");
    while (!isInLava(bot) || !isBurning(bot)) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    bot.chat("/setblock 0 -60 0 air");
    while (isInLava(bot)) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
  }
  if (!(await hurt(context, startingHealth))) throw new Error(`Could not arrange ${startingHealth} health.`);
  const start = bot.entity.position.clone();
  let shots = 0;
  let minimumHealth = bot.health;
  let maximumDistance = 0;
  const spawn = (entity: typeof bot.entity) => {
    if (["small_fireball", "arrow"].includes(entity.name ?? "")) shots++;
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    maximumDistance = Math.max(maximumDistance, bot.entity.position.distanceTo(start));
  };
  bot.once("death", onDeath);
  bot.on("entitySpawn", spawn);
  bot.on("physicsTick", tick);
  const range = mob === "skeleton" ? 12 : 18;
  const equipment = mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
  for (const [x, z] of [
    [range + 0.5, 0.5],
    [-range + 0.5, 0.5],
  ])
    bot.chat(`/summon ${mob} ${x} -60 ${z} {PersistenceRequired:1b${equipment}}`);
  try {
    // Admit the policy with an actual projectile already in flight, not merely
    // with a passive shooter in sight that an early sprint can leave behind.
    while (shots === 0 && bot.health > 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const runtime = await openRuntime(context, `wounded-${mob}-shelter`);
    try {
      bot.chat("/gamerule naturalRegeneration true");
      while (bot.health < 18 && bot.health > 0) {
        signal.throwIfAborted();
        await bot.waitForTicks(1);
      }
      const encounters = await readEncounters(context, runtime);
      const recovered = bot.health >= 18;
      return {
        status: shots > 0 && recovered && minimumHealth > 0 ? "succeeded" : "failed",
        detail: JSON.stringify({ protection, encounters, shots, health: bot.health, minimumHealth, maximumDistance }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    bot.off("death", onDeath);
    bot.off("entitySpawn", spawn);
    bot.off("physicsTick", tick);
  }
};
