import { createMovements, exactBlockGoal } from "../../../src/navigation/index.ts";
import { Vec3 } from "vec3";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await standStill(context);
  const cell = new Vec3(0, -60, 2);
  const outcome = await navigation.navigate({
    movements: createMovements(bot, { scaffolding: false }),
    goal: exactBlockGoal(new Vec3(0, -60, 4)),
    signal,
  });
  const spawner = bot.blockAt(cell)?.name;
  // The bedrock corridor deliberately has no alternate route. A refusal is
  // correct: ordinary travel must not consume the source of a future hunt.
  return {
    status: spawner === "spawner" && bot.entity.position.z < 2 ? "succeeded" : "failed",
    detail: JSON.stringify({ outcome, spawner, position: bot.entity.position }),
  };
};
