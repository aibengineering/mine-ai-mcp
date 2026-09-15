import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { pickupObservedItem } from "../../../src/world/item-pickup.ts";
import { createMovements } from "../../../src/navigation/index.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Pickup start did not settle.");
  bot.chat('/summon minecraft:item 3.5 -57 0.5 {Item:{id:"minecraft:ender_pearl",count:1},PickupDelay:0s}');
  await bot.waitForTicks(10);
  const pearl = bot.nearestEntity((entity) => entity.name === "item");
  if (!pearl) throw new Error("Pearl missing.");
  const id = bot.registry.itemsByName.ender_pearl!.id;
  const result = await pickupObservedItem(bot, { entityId: pearl.id, movements: createMovements(bot),
    navigate: navigation.navigate, signal, hasArrived: () => bot.inventory.count(id, null) >= 1 });
  return { status: result.kind === "collected" && bot.health > 0 ? "succeeded" : "failed",
    detail: JSON.stringify({ result, pearls: bot.inventory.count(id, null), health: bot.health }) };
};
