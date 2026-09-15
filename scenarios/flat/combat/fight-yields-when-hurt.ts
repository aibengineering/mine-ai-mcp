import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";
import { hurt, readEncounters } from "./reflex.ts";

/** Survive health loss during native contact; the response sequence is telemetry. */
export const run: MineAiScenario = async (context) => {
  const runtime = await openRuntime(context, "fight-health-boundary");
  let died = false;
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    context.bot.chat("/execute as @e[type=zombie] run data merge entity @s {NoAI:0b}");
    await context.bot.waitForTicks(20);
    if (context.bot.health > 11 && !(await hurt(context, 11)))
      return { status: "failed", detail: "Could not arrange health loss during native contact." };
    for (let tick = 0; tick < 1200 && !died; tick++) {
      context.signal.throwIfAborted();
      await context.bot.waitForTicks(1);
    }
    const encounters = await readEncounters(context, runtime);
    return {
      status: !died && context.bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ died, health: context.bot.health, encounters }),
    };
  } finally {
    context.bot.off("death", death);
    await runtime.close();
  }
};
