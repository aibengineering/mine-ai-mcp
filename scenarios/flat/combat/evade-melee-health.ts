import type { BotEvents } from "mineflayer";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { hurt, readEncounters } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  await wearArmor(context);
  if (!(await hurt(context, 11))) return { status: "failed", detail: "Could not arrange health11." };
  // Let the setup damage immunity expire while both attackers still have NoAI.
  await bot.waitForTicks(12);
  const started = Date.now();
  let died = false;
  let minimumHealth = bot.health;
  let finalPosition = bot.entity.position.clone();
  const health: BotEvents["health"] = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    context.log(
      `health ${JSON.stringify({ ms: Date.now() - started, health: bot.health, position: bot.entity.position, forward: bot.getControlState("forward"), sprint: bot.getControlState("sprint") })}`,
    );
  };
  const death = () => {
    died = true;
    finalPosition = bot.entity.position.clone();
  };
  bot.on("health", health);
  bot.on("death", death);
  const runtime = await openRuntime(context, "evade-melee-health");
  try {
    // Start the native pressure after the runtime is ready. How survival deals
    // with that pressure is policy, and is reported only as telemetry.
    bot.chat("/execute as @e[type=minecraft:wither_skeleton] run data merge entity @s {NoAI:0b}");
    for (let tick = 0; tick < 400 && !died; tick++) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const encounters = await readEncounters(context, runtime);
    if (!died) finalPosition = bot.entity.position.clone();
    return {
      status: !died && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        died,
        minimumHealth,
        crossedHideThreshold: minimumHealth < 8,
        health: bot.health,
        finalPosition,
        encounters,
      }),
    };
  } finally {
    await runtime.close();
    bot.off("health", health);
    bot.off("death", death);
  }
};
