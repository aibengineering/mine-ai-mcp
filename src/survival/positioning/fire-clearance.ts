import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { observedEyeHeight } from "../../world/block-visibility.js";
import { clearCombatRay } from "../../world/entity-geometry.js";
import { fireAt } from "../perception/body.js";

/** Clear observed fire without excavating terrain or changing equipment. */
export async function extinguishFireAt(
  bot: Bot,
  cell: Vec3,
  signal: AbortSignal,
  digAllowed: boolean,
): Promise<"clear" | "blocked"> {
  if (!fireAt(bot, cell)) return "clear";
  if (!digAllowed) return "blocked";
  const block = bot.blockAt(cell)!;
  if (!bot.canDigBlock(block)) return "blocked";
  const aim = cell.offset(0.5, 0.5, 0.5);
  const eye = bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0);
  if (!clearCombatRay(bot.world, eye, aim)) return "blocked";
  signal.throwIfAborted();
  await bot.lookAt(aim, true);
  signal.throwIfAborted();
  if (!fireAt(bot, cell)) return "clear";
  const cancel = () => bot.stopDigging();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await bot.dig(block, "ignore");
    signal.throwIfAborted();
    return fireAt(bot, cell) ? "blocked" : "clear";
  } catch {
    signal.throwIfAborted();
    return "blocked";
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
