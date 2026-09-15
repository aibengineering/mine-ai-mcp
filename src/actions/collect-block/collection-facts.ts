/** Collect-specific interpretations over Mineflayer's versioned facts. */
import { enchantmentsOf } from "../../world/enchantments.js";
import type { Bot } from "mineflayer";

// Upstream loot facts do not currently give Collect one correct ordinary-break
// result here: minecraft-data uses the old `grass` name and omits the shears
// conditions, while Prismarine Block exposes no drops for these plants.
const ORDINARY_BREAK_DROP_OVERRIDES: Readonly<Record<string, string>> = {
  short_grass: "wheat_seeds",
  tall_grass: "wheat_seeds",
  fern: "wheat_seeds",
  large_fern: "wheat_seeds",
  // minecraft-data lists the sheared block before string without a tool
  // condition. Collection already accepts the block itself as well as this drop.
  cobweb: "string",
};

export function blockMatchesSelector(blockName: string, selector: string): boolean {
  if (selector === "log" || selector === "logs") return blockName.endsWith("_log");
  return blockName === selector || (selector.endsWith("_ore") && blockName === `deepslate_${selector}`);
}

function registryDropId(drop: unknown): number | null {
  if (typeof drop === "number") return drop;
  if (!drop || typeof drop !== "object") return null;
  const value = (drop as { drop?: number | { id?: number } }).drop;
  if (typeof value === "number") return value;
  return typeof value?.id === "number" ? value.id : null;
}

/** Choose the inventory item Collect should observe after the equipped tool breaks this block. */
export function expectedDropName(bot: Bot, blockName: string): string {
  const ordinaryBreakDrop = ORDINARY_BREAK_DROP_OVERRIDES[blockName];
  if (ordinaryBreakDrop) return ordinaryBreakDrop;

  const silkTouch = enchantmentsOf(bot, bot.heldItem).some((enchantment) => enchantment.name === "silk_touch");
  const loot = bot.registry.blockLoot[blockName]?.drops.find((drop) => {
    if (drop.silkTouch) return silkTouch;
    if (drop.noSilkTouch) return !silkTouch;
    return true;
  });
  if (loot) return loot.item;

  const firstDrop = bot.registry.blocksByName[blockName]?.drops?.[0];
  const itemId = registryDropId(firstDrop);
  return (itemId === null ? null : bot.registry.items[itemId]?.name) ?? blockName;
}

export function inventoryCounts(bot: Bot): Record<string, number> {
  return bot.inventory.items().reduce<Record<string, number>>((counts, item) => {
    counts[item.name] = (counts[item.name] || 0) + item.count;
    return counts;
  }, {});
}

export function inventoryGains(
  bot: Bot,
  before: Readonly<Record<string, number>>,
  itemNames: Iterable<string>,
): Record<string, number> {
  const current = inventoryCounts(bot);
  return [...new Set(itemNames)].sort().reduce<Record<string, number>>((gains, itemName) => {
    const gained = Math.max(0, (current[itemName] || 0) - (before[itemName] || 0));
    if (gained > 0) gains[itemName] = gained;
    return gains;
  }, {});
}
