import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

const CHESTS = new Set(["chest", "trapped_chest", "ender_chest"]);

/** A chest lid cannot open beneath an opaque full cube. Glass and slabs leave it usable. */
export function chestOpeningObstruction(bot: Bot, name: string, position: Vec3): string | null {
  if (!CHESTS.has(name)) return null;
  const above = bot.blockAt(position.offset(0, 1, 0));
  if (!above) return `[CHEST_CLEARANCE_UNLOADED] The cell above ${name} at ${position} is not loaded.`;
  if (
    !above.transparent &&
    above.shapes.some(
      ([x0, y0, z0, x1, y1, z1]) => x0 === 0 && y0 === 0 && z0 === 0 && x1 === 1 && y1 === 1 && z1 === 1,
    )
  ) {
    return `[CHEST_BLOCKED] The ${name} at ${position} cannot open: ${above.name} is directly above it at ${position.offset(0, 1, 0)}.`;
  }
  return null;
}
