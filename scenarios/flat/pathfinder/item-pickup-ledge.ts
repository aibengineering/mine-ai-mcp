import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";
import { createMovements } from "../../../src/navigation/index.ts";
import { pickupObservedItem } from "../../../src/world/item-pickup.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await standStill(context);
  // Fixture-only operator command: spawn after login so its motion and pickup
  // delay are still active when the production pickup transaction starts.
  bot.chat(
    '/summon item 0.925 -58 1.7 {Item:{id:"minecraft:diamond",count:1},Motion:[0.0d,0.0d,-0.42d],PickupDelay:20s,Age:-32768s}',
  );
  let item = Object.values(bot.entities).find((entity) => entity.name === "item");
  while (!item) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
    item = Object.values(bot.entities).find((entity) => entity.name === "item");
  }
  const hasArrived = () => bot.inventory.count(bot.registry.itemsByName.diamond!.id, null) >= 1;
  const result = await pickupObservedItem(bot, {
    entityId: item.id,
    movements: createMovements(bot),
    navigate: navigation.navigate,
    hasArrived,
    signal,
  });
  return {
    status: hasArrived() ? "succeeded" : "failed",
    detail: `${result.kind}; bot=${bot.entity.position}; item=${bot.entities[item.id]?.position}; ${context.pathfinder.summary()}`,
  };
};
