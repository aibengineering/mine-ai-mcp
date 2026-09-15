import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await bot.waitForChunksToLoad();
  await using runtime = await openRuntime(context, "inventory-fills-during-collection");
  const action = runtime.actions.find((a) => a.name === "collect_block")!;
  const result = await runtime.run(action, { block_name: "stone", count: 4 }, signal);
  const count = bot.inventory.count(bot.registry.itemsByName.cobblestone!.id, null);
  const correct = result.result.status === "partial" && /INVENTORY_FULL/.test(result.result.error ?? "") && count === 64;
  return { status: correct ? "succeeded" : "failed", detail: JSON.stringify({ count, result }) };
};
