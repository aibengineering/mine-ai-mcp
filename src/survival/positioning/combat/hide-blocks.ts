/**
 * What the emergency hide builds a box out of.
 *
 * Two decisions turn on the same count and must not disagree about it: the
 * hide chooses between walling in and digging by how many blocks it carries,
 * and the policy's memory of a hide that could not be built clears the moment
 * that count changes. A second list would be a second answer to "could the bot
 * build a box here", and the two would drift.
 *
 * So there is one list of what to spend first, and one rule for everything
 * else it carries: a safe full cube closes a wall just as well whether it is
 * cobblestone or acacia planks. Partial blocks, falling blocks, interactive
 * blocks, and liquids do not, and neither does an item that is not a block.
 * An explicit list stays authoritative: the dragon hide passes its resistant
 * names and gets exactly those, with no fallback that would burn a plank
 * against dragon breath.
 */
import type { Bot } from "mineflayer";
import { blockClass } from "../../../world/block-class.js";
import { observeMineflayerBlock } from "../../../navigation/mineflayer/world.js";

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

/**
 * Whether this carried item is a cube that can be stacked into a wall.
 *
 * The same shape the scaffold planner admits: a full cube with a standable,
 * non-damaging top, which nothing right-clicks, which does not fall, and which
 * is not a liquid. A slab has half a cell and a ladder has no collision, so
 * neither closes a wall; sand falls out of it; a chest or furnace would open
 * on placement; a water bucket is not a block at all.
 *
 * Answering costs a Prismarine block per item, and the survival tick asks for
 * this count several times and the answer depends only on the registry, so the
 * verdict is cached per registry and item name.
 */
const wallMaterial = new WeakMap<Bot["registry"], Map<string, boolean>>();

function isWallMaterial(bot: Bot, name: string): boolean {
  const cache = wallMaterial.get(bot.registry) ?? new Map<string, boolean>();
  wallMaterial.set(bot.registry, cache);
  const known = cache.get(name);
  if (known !== undefined) return known;
  const block = bot.registry.blocksByName[name];
  let answer = false;
  if (block) {
    const { geometry, traits } = observeMineflayerBlock(
      blockClass(bot).fromStateId(block.defaultState, 0),
    );
    answer =
      geometry.fullCube &&
      geometry.safeSupport &&
      !traits.interactive &&
      !traits.falling &&
      traits.liquid === null;
  }
  cache.set(name, answer);
  return answer;
}

/** The carried stack the hide would place from, or null when it carries none. */

export function capBlock(bot: Bot, names?: readonly string[]): Item | null {
  const items = bot.inventory.items();
  // An explicit list is authoritative and keeps its own preference order.
  if (names) {
    for (const name of names) {
      const item = items.find((candidate) => candidate.name === name);
      if (item) return item;
    }
    return null;
  }
  for (const name of HIDE_CAP_BLOCKS) {
    const item = items.find((candidate) => candidate.name === name);
    if (item) return item;
  }
  return items.find((candidate) => isWallMaterial(bot, candidate.name)) ?? null;
}

/** How many blocks the bot has to build a hide with. */

export function countCapBlocks(bot: Bot, names?: readonly string[]): number {
  const items = bot.inventory.items();
  if (names) {
    return items
      .filter((candidate) => names.includes(candidate.name))
      .reduce((total, item) => total + item.count, 0);
  }
  return items
    .filter((candidate) => isWallMaterial(bot, candidate.name))
    .reduce((total, item) => total + item.count, 0);
}
