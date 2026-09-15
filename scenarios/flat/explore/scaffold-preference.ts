import type { MineAiScenario } from "../../src/scenario-client.ts";
import { run as explore } from "../../src/explorer.ts";

export const run: MineAiScenario = async (context) => {
  const material = context.bot.registry.itemsByName.netherrack!.id;
  const before = context.bot.inventory.count(material, null);
  const result = await explore(context);
  const spent = before - context.bot.inventory.count(material, null);
  return {
    status: result.status,
    detail: JSON.stringify({ exploration: result, scaffoldsSpent: spent }),
  };
};
