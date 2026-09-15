/**
 * The bot is asked to do nothing and is made hungry; the hunger reflex must
 * eat what it carries without being asked, and the bot must end fed.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /** Hunger to bring the bot down to before the reflex may act. Requires `op`. */
  hungerTo: z.number().int().min(0).max(20),
  waitTicks: z.number().int().positive(),
});

/**
 * Drain hunger with the hunger effect, from the client so the scenario can
 * wait for the bar to actually reach the target before the trial starts.
 */
// @function-metrics size=8 branches=2 fan-out=5 depth=2 interface=2 fan-in=1
export async function starve(context: MineAiScenarioContext, target: number): Promise<boolean> {
  const { bot } = context;
  bot.chat("/effect give @s minecraft:hunger 60 255 true");
  for (let waited = 0; waited < 1200; waited += 1) {
    context.signal.throwIfAborted();
    if (bot.food <= target) {
      bot.chat("/effect clear @s minecraft:hunger");
      return true;
    }
    await bot.waitForTicks(1);
  }
  bot.chat("/effect clear @s minecraft:hunger");
  return false;
}

// @function-metrics size=15 branches=6 fan-out=9 depth=3 interface=1 fan-in=0
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  if (!(await starve(context, params.hungerTo)))
    return { status: "failed", detail: "Arrangement did not establish the declared hunger." };
  const hungerAtStart = context.bot.food;
  const runtime = await openRuntime(context, "survival-hunger");
  let died = false;
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    for (let tick = 0; tick < params.waitTicks && !died; tick++) {
      context.signal.throwIfAborted();
      if (context.bot.food > hungerAtStart && context.bot.health > 0) {
        const detail = `hunger ${hungerAtStart} -> ${context.bot.food}; health ${context.bot.health}`;
        return { status: "succeeded", detail };
      }
      await context.bot.waitForTicks(1);
    }
    return { status: "failed", detail: `Hunger did not rise; food ${context.bot.food}, died ${died}.` };
  } finally {
    context.bot.off("death", death);
    await runtime.close();
  }
}
