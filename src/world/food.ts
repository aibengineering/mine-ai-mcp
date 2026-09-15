import type { Bot } from "mineflayer";
/** Vanilla natural regeneration requires at least this many hunger points. */
export const REGENERATION_HUNGER = 18;
type Item = ReturnType<Bot["inventory"]["items"]>[number];

/** Foods the reflex never chooses; each carries an effect the model should weigh for itself. */
export const REFLEX_AVOIDED_FOODS: ReadonlySet<string> = new Set([
  "rotten_flesh",
  "spider_eye",
  "poisonous_potato",
  "pufferfish",
  "chicken",
  "suspicious_stew",
  "chorus_fruit",
  "enchanted_golden_apple",
]);

/** Foods with a cooked form, keyed by the raw item; eating them raw forfeits most of their value. */
export const COOKED_FORMS: Readonly<Record<string, string>> = Object.freeze({
  beef: "cooked_beef",
  porkchop: "cooked_porkchop",
  chicken: "cooked_chicken",
  mutton: "cooked_mutton",
  rabbit: "cooked_rabbit",
  cod: "cooked_cod",
  salmon: "cooked_salmon",
  potato: "baked_potato",
});

export function isRawFood(name: string): boolean {
  return Object.hasOwn(COOKED_FORMS, name);
}

export type ReflexFood = Item;

/**
 * The most filling carried food the reflex is allowed to eat, or null.
 *
 * Whether uncooked food is on the menu is the caller's decision, taken from
 * policy against the bot's current vitals; see the survival raw_food rule.
 */
export function selectReflexFood(bot: Bot, options: { readonly allowRaw: boolean }): Item | null {
  let best: Item | null = null;
  let bestPoints = -1;
  let bestSaturation = -1;
  for (const item of bot.inventory.items()) {
    const food = bot.registry.foodsByName[item.name];
    if (!food || REFLEX_AVOIDED_FOODS.has(item.name)) continue;
    if (!options.allowRaw && isRawFood(item.name)) continue;
    if (food.foodPoints > bestPoints || (food.foodPoints === bestPoints && food.saturation > bestSaturation)) {
      best = item;
      bestPoints = food.foodPoints;
      bestSaturation = food.saturation;
    }
  }
  return best;
}
