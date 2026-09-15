import type { Bot } from "mineflayer";

/** Whether at least one named item can enter a free slot or a non-full stack. */
export function hasInventorySpaceFor(inventory: Bot["inventory"], itemNames: ReadonlySet<string>): boolean {
  return (
    inventory.emptySlotCount() > 0 ||
    inventory.items().some((item) => itemNames.has(item.name) && item.count < item.stackSize)
  );
}
