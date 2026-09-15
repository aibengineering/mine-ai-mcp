import { ActionRunner, createCraftItemAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ navigation, bot, signal }) => {
  const result = await new ActionRunner().run(
    createCraftItemAction(bot, navigation),
    {
      items: [{ item_name: "birch_door", count: 1 }],
    },
    signal,
  );
  const confirmed = "craft" in result.result && result.result.craft.items[0]?.confirmed;
  return {
    status: result.result.status === "succeeded" && confirmed ? "succeeded" : "failed",
    detail: JSON.stringify(result),
  };
};
