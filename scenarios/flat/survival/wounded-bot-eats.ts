import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";
import { hurt } from "../combat/reflex.ts";
import { starve } from "./hunger.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await starve(context, 17)) || !(await hurt(context, 14))) {
    return { status: "failed", detail: "Could not arrange wounded, regeneration-blocked vitals." };
  }
  const healthBefore = bot.health;
  const hungerBefore = bot.food;
  if (hungerBefore <= 14 || hungerBefore >= 18) {
    return { status: "failed", detail: `Expected hunger between 14 and 18, observed ${hungerBefore}.` };
  }
  const runtime = await openRuntime(context, "wounded-hunger");
  try {
    // After the meal's saturation is spent, regeneration adds only one health
    // every four seconds. Allow that slower phase to cross eighteen as well.
    for (let tick = 0; tick < 400; tick += 1) {
      signal.throwIfAborted();
      if (bot.health >= 18) {
        return {
          status: "succeeded",
          detail: `Recovered: health ${healthBefore} -> ${bot.health}, hunger ${hungerBefore} -> ${bot.food}.`,
        };
      }
      await bot.waitForTicks(1);
    }
    return {
      status: "failed",
      detail: `Recovery did not complete: health ${healthBefore} -> ${bot.health}, hunger ${hungerBefore} -> ${bot.food}.`,
    };
  } finally {
    await runtime.close();
  }
};
