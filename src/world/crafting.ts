import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { CraftApplication } from "../utils/craft-plan.js";

export type CraftExecution =
  | { readonly kind: "completed"; readonly completedSteps: number }
  | { readonly kind: "failed"; readonly completedSteps: number; readonly cause: unknown };

type ItemLoader = (registry: Bot["registry"]) => typeof Item;
const loadItem = createRequire(import.meta.url)("prismarine-item") as ItemLoader;

/** Native craft stores each application's output before starting the next one. */
function requireApplicationRoom(bot: Bot, recipe: CraftApplication["recipe"]): void {
  const Item = loadItem(bot.registry);
  const stacks = bot.inventory.items().map((item) => ({ item, count: item.count }));
  let emptySlots = bot.inventory.inventoryEnd - bot.inventory.inventoryStart - stacks.length;
  for (const ingredient of recipe.delta) {
    if (ingredient.count >= 0) continue;
    let remaining = -ingredient.count;
    for (const stack of stacks) {
      if (
        stack.item.type !== ingredient.id ||
        (ingredient.metadata != null && stack.item.metadata !== ingredient.metadata)
      )
        continue;
      const consumed = Math.min(remaining, stack.count);
      if (consumed === 0) continue;
      stack.count -= consumed;
      remaining -= consumed;
      if (stack.count === 0) emptySlots += 1;
      if (remaining === 0) break;
    }
  }
  for (const output of recipe.delta) {
    if (output.count <= 0) continue;
    const item = new Item(output.id, output.count, output.metadata ?? 0);
    let remaining = output.count;
    for (const stack of stacks) {
      if (stack.count === 0 || !Item.equal(stack.item, item, false, true)) continue;
      const stored = Math.min(remaining, Math.max(0, stack.item.stackSize - stack.count));
      stack.count += stored;
      remaining -= stored;
    }
    const neededSlots = Math.ceil(remaining / item.stackSize);
    if (neededSlots > emptySlots) {
      // Minecraft may permit a different click sequence; this executor stores
      // every native application separately and must not let putAway toss it.
      throw new Error(
        `This crafting execution needs inventory room to store ${output.count} ${item.name} before the next recipe application.`,
      );
    }
    emptySlots -= neededSlots;
  }
}

/** Execute one native recipe application at a time and close the inventory afterward. */
export async function executeCraftPlan(
  bot: Bot,
  applications: readonly CraftApplication[],
  craftingTable: NonNullable<Parameters<Bot["craft"]>[2]> | null,
  signal?: AbortSignal,
): Promise<CraftExecution> {
  let completedSteps = 0;
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  bot.closeWindow(bot.inventory);
  try {
    for (const application of applications) {
      for (let made = 0; made < application.applications; made += 1) {
        signal?.throwIfAborted();
        requireApplicationRoom(bot, application.recipe);
        await bot.craft(application.recipe, 1, craftingTable ?? undefined);
      }
      completedSteps += 1;
    }
    signal?.throwIfAborted();
    return { kind: "completed", completedSteps };
  } catch (cause) {
    signal?.throwIfAborted();
    return { kind: "failed", completedSteps, cause };
  } finally {
    bot.closeWindow(bot.inventory);
  }
}
