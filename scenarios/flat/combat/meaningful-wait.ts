import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Reach the destination alive despite a delayed returning attacker. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  if (!(await standStill(context))) throw new Error("The delayed-contact scene did not settle.");
  const target = Object.values(bot.entities).find((entity) => entity.name === "enderman");
  if (!target) throw new Error("The declared enderman was not observed.");
  const runtime = await openRuntime(context, "delayed-contact-navigation");
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const death = () => died.abort("bot died");
  bot.on("death", death);
  try {
    bot.chat("/attribute @e[tag=patient_target,limit=1] minecraft:movement_speed base set 0");
    bot.chat("/damage @e[tag=patient_target,limit=1] 1 minecraft:player_attack by @s");
    bot.chat("/data merge entity @e[tag=patient_target,limit=1] {NoAI:1b}");
    bot.chat(`/tp @e[tag=patient_target,limit=1] ${bot.entity.position.x + 10} -60 ${bot.entity.position.z}`);
    const pending = runtime.run(
      runtime.actions.find((action) => action.name === "navigate")!,
      { x: 80, y: -60, z: 0 },
      signal,
    );
    // The native attacker returns after ten seconds whether the bot waited or made progress.
    for (let tick = 0; tick < 200; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    bot.chat("/data merge entity @e[tag=patient_target,limit=1] {NoAI:0b}");
    bot.chat(`/tp @e[tag=patient_target,limit=1] ${bot.entity.position.x + 1.5} -60 ${bot.entity.position.z}`);
    const output = await pending;
    const remaining = Math.hypot(bot.entity.position.x - 80.5, bot.entity.position.y + 60, bot.entity.position.z - 0.5);
    return {
      status: !died.signal.aborted && bot.health > 0 && remaining <= 2 ? "succeeded" : "failed",
      detail: JSON.stringify({ output, remaining, health: bot.health, died: died.signal.aborted }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: "Bot died before completing delayed-contact navigation." };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
};
