/**
 * What the emergency hide builds a box out of.
 *
 * Two decisions turn on the same count and must not disagree about it: the
 * hide chooses between walling in and digging by how many blocks it carries,
 * and the policy's memory of a hide that could not be built clears the moment
 * that count changes. A second list would be a second answer to "could the bot
 * build a box here", and the two would drift.
 */
import type { Bot } from "mineflayer";

type Item = ReturnType<Bot["inventory"]["items"]>[number];

/** Blocks worth spending on a wall or a cap, most common first. */
const HIDE_CAP_BLOCKS: readonly string[] = [
  "cobblestone",
  "dirt",
  "cobbled_deepslate",
  "end_stone",
  "stone",
  "netherrack",
  "oak_planks",
  "spruce_planks",
  "birch_planks",
];

/** Full shelter blocks that survive native dragon terrain destruction. */
export const DRAGON_PROTECTION_BLOCKS: readonly string[] = ["end_stone", "obsidian", "bedrock"];

/** The carried stack the hide would place from, or null when it carries none. */

export function capBlock(bot: Bot, names: readonly string[] = HIDE_CAP_BLOCKS): Item | null {
  const items = bot.inventory.items();
  for (const name of names) {
    const item = items.find((candidate) => candidate.name === name);
    if (item) return item;
  }
  return null;
}

/** How many blocks the bot has to build a hide with. */

export function countCapBlocks(bot: Bot, names: readonly string[] = HIDE_CAP_BLOCKS): number {
  return bot.inventory
    .items()
    .filter((candidate) => names.includes(candidate.name))
    .reduce((total, item) => total + item.count, 0);
}
