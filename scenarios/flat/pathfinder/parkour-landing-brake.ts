import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("The parkour takeoff did not settle");
  let lava = false;
  let minimumHealth = bot.health;
  const observe = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  bot.on("physicsTick", observe);
  try {
    // Inherited run-up from the failing native fortress route, translated to
    // this isolated platform. All subsequent movement uses production navigation.
    bot.entity.velocity.set(0.1062081801, -0.0784000015, -0.0216411059);
    const result = await navigation.navigate({
      goal: exactBlockGoal({ x: 5, y: -56, z: 0 }),
      movements: createMovements(bot, { allowDigging: false, scaffolding: false }),
      signal,
    });
    await bot.waitForTicks(20);
    return {
      status:
        result.status === "completed" && bot.entity.onGround && !lava && minimumHealth === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ result, lava, minimumHealth, position: bot.entity.position }),
    };
  } finally {
    bot.off("physicsTick", observe);
  }
};
