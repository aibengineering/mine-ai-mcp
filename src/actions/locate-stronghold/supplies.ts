import type { Bot } from "mineflayer";
import { REFLEX_AVOIDED_FOODS } from "../../world/food.js";
import type { LocateStrongholdResult } from "./contract.js";

/** One checklist supplies both the preparation message and the departure warning. */
export function strongholdSupplies(bot: Bot): LocateStrongholdResult["supplies"] {
  // Include armor, offhand and crafting inputs, but not slot 0's uncrafted output.
  const items = bot.inventory.slots.slice(1).filter((item) => item !== null);
  const count = (accept: (name: string) => boolean) =>
    items.reduce((total, item) => total + (accept(item.name) ? item.count : 0), 0);
  const named = (name: string) => count((candidate) => candidate === name);
  const tiered = (piece: string) =>
    count((name) => ["iron", "diamond", "netherite"].some((tier) => name === `${tier}_${piece}`));
  return [
    { recommendation: "Carved pumpkin to wear against Enderman gaze", carried: named("carved_pumpkin"), required: 1 },
    { recommendation: "Bow for End crystals", carried: named("bow"), required: 1 },
    { recommendation: "Regular arrows", carried: named("arrow"), required: 64 },
    {
      recommendation: "Auto-edible food items for the journey and fight",
      carried: count((name) => !!bot.registry.foodsByName[name] && !REFLEX_AVOIDED_FOODS.has(name)),
      required: 16,
    },
    ...["helmet", "chestplate", "leggings", "boots"].map((piece) => ({
      recommendation: `Iron-or-better ${piece}`,
      carried: tiered(piece),
      required: 1,
    })),
    { recommendation: "Iron-or-better sword or axe", carried: tiered("sword") + tiered("axe"), required: 1 },
    { recommendation: "Shield", carried: named("shield"), required: 1 },
  ];
}
