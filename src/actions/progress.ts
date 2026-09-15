import type { Bot } from "mineflayer";
import { z } from "zod";
import type { ActionContext } from "./action.js";
import { carriedCount } from "../world/inventory-count.js";

const inventoryCheckpointSchema = z.strictObject({
  phase: z.string(),
  items: z.array(z.strictObject({ item: z.string(), initial: z.number(), current: z.number(), gained: z.number(), requested: z.number() })),
});

/** Current carried achievement can decrease; it is never a count of attempted effects. */
export function observeInventoryProgress(
  context: ActionContext, bot: Bot, targets: readonly { itemName: string; count: number }[],
  phase: () => string, completion: string,
): void {
  const items = targets.map(({ itemName, count }) => ({ item: itemName, requested: count, initial: carriedCount(bot, itemName) }));
  context.observeProgress?.(() => {
    const checkpoint = inventoryCheckpointSchema.parse({ phase: phase(), items: items.map((item) => {
      const current = carriedCount(bot, item.item);
      return { ...item, current, gained: current - item.initial };
    }) });
    return { baseline: items, checkpoint, completion: { kind: "current", observed: checkpoint.items.every((item) => item.gained >= item.requested), owes: completion } };
  });
}
