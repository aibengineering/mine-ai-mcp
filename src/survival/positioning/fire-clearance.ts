import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { observedEyeHeight } from "../../world/block-visibility.js";
import { clearCombatRay } from "../../world/entity-geometry.js";
import { fireAt } from "../perception/body.js";
import { isReplaceableForPlacement } from "../../world/block-classification.js";

/** Clear observed fire without excavating terrain or changing equipment. */
export function extinguishFireAt(
  bot: Bot,
  cell: Vec3,
  signal: AbortSignal,
  digAllowed: boolean,
): Promise<"clear" | "blocked"> {
  return punchOut(bot, cell, signal, digAllowed, () => fireAt(bot, cell));
}

/**
 * A block with no collision that breaks at the first touch, but that a
 * placement does not replace: twisting and weeping vines, cave vines, sugar
 * cane. Vanilla refuses a block placed into such a cell, so a wall there
 * needs the plant punched out first, as fire is.
 */
export function instantObstruction(block: ReturnType<Bot["blockAt"]>): boolean {
  return block !== null && block.hardness === 0 && block.boundingBox === "empty" && !isReplaceableForPlacement(block);
}

/** Punch out an instant obstruction without excavating terrain or changing equipment. */
export function clearInstantObstructionAt(
  bot: Bot,
  cell: Vec3,
  signal: AbortSignal,
  digAllowed: boolean,
): Promise<"clear" | "blocked"> {
  return punchOut(bot, cell, signal, digAllowed, () => instantObstruction(bot.blockAt(cell)));
}

async function punchOut(
  bot: Bot,
  cell: Vec3,
  signal: AbortSignal,
  digAllowed: boolean,
  present: () => boolean,
): Promise<"clear" | "blocked"> {
  if (!present()) return "clear";
  if (!digAllowed) return "blocked";
  const block = bot.blockAt(cell)!;
  if (!bot.canDigBlock(block)) return "blocked";
  const aim = cell.offset(0.5, 0.5, 0.5);
  const eye = bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0);
  if (!clearCombatRay(bot.world, eye, aim)) return "blocked";
  signal.throwIfAborted();
  await bot.lookAt(aim, true);
  signal.throwIfAborted();
  if (!present()) return "clear";
  const cancel = () => bot.stopDigging();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await bot.dig(block, "ignore");
    signal.throwIfAborted();
    return present() ? "blocked" : "clear";
  } catch {
    signal.throwIfAborted();
    return "blocked";
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
