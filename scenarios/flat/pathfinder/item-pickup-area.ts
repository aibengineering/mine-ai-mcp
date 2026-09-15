import { pickUpItemsResultSchema } from "@aibengineering/mine-ai-mcp";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await bot.waitForChunksToLoad();
  await using runtime = await openRuntime(context, "item-pickup-area");
  const action = runtime.actions.find((candidate) => candidate.name === "pick_up_items")!;
  const output = await runtime.run(action, { item: "diamond", x: 7.5, y: -58, z: 0.5, radius: 12 }, signal);
  const result = "kind" in output.result ? null : pickUpItemsResultSchema.parse(output.result);
  const diamonds = bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
  const gravel = bot.inventory.count(bot.registry.itemsByName.gravel!.id, null);
  const passed = result?.status === "succeeded" && result.pickup.observed === 3 &&
    result.pickup.collected === 3 && result.pickup.gainedByItem.diamond === 6 && diamonds === 6 && gravel === 0;
  return { status: passed ? "succeeded" : "failed", detail: JSON.stringify({ diamonds, gravel, output }) };
};
