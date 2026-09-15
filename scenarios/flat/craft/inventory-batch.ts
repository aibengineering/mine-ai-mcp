import { ActionRunner, createCraftItemAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ navigation, bot, signal }) => {
  const output = await new ActionRunner().run(
    createCraftItemAction(bot, navigation),
    {
      items: [
        { item_name: "crafting_table", count: 1 },
        { item_name: "oak_planks", count: 32 },
      ],
    },
    signal,
  );
  const result = output.result;
  return {
    status:
      result.status === "succeeded" && "craft" in result && result.craft.items.every((item) => item.confirmed)
        ? "succeeded"
        : "failed",
    detail: JSON.stringify(output),
  };
};
