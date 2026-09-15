import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const runner = new ActionRunner();
  const action = createNavigateAction(bot, navigation);
  const route = await runner.run(action, { x: 6, y: -60, z: 0, range: 0, scaffold: false }, signal);
  const chest = bot.blockAt(new Vec3(2, -60, 0));
  const table = bot.blockAt(new Vec3(4, -60, 0));
  if (chest?.name !== "chest" || table?.name !== "crafting_table")
    return { status: "failed", detail: JSON.stringify({ route, chest: chest?.name, table: table?.name }) };
  const back = await runner.run(action, { x: 0, y: -60, z: 0, range: 0, scaffold: false }, signal);
  const container = await bot.openContainer(chest);
  let pearls = 0,
    gold = 0;
  try {
    for (const item of container.containerItems()) {
      if (item.name === "ender_pearl") pearls += item.count;
      if (item.name === "gold_ingot") gold += item.count;
    }
  } finally {
    container.close();
  }
  return {
    status:
      route.result.status === "succeeded" && back.result.status === "succeeded" && pearls === 12 && gold === 79
        ? "succeeded"
        : "failed",
    detail: JSON.stringify({ route, back, pearls, gold }),
  };
};
