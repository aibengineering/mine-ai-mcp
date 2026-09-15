import type { Bot } from "mineflayer";
import { REFLEX_AVOIDED_FOODS } from "../../world/food.js";

export type PortalDestination = "overworld" | "the_nether" | "the_end";

export function portalSupplyWarning(bot: Bot, destination: PortalDestination): string | null {
  if (destination === "overworld") return null;
  let food = 0;
  let arrows = 0;
  for (const item of bot.inventory.items()) {
    if (bot.registry.foodsByName[item.name] && !REFLEX_AVOIDED_FOODS.has(item.name)) food += item.count;
    if (item.name === "arrow") arrows += item.count;
  }
  return food < 16 || arrows < 32
    ? `[PORTAL_LOW_SUPPLIES] Portal entry paused: ${food}/16 auto-edible food items and ${arrows}/32 regular arrows carried. Set allow_low_supplies: true to continue regardless.`
    : null;
}
