import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/** Collision shapes touched by the whole body, excluding faces merely touching. */
function obstruction(bot: Bot, position: Vec3): ReturnType<Bot["blockAt"]> {
  const radius = (bot.entity.width ?? 0.6) / 2;
  const height = bot.entity.height ?? 1.8;
  const low = position.offset(-radius + 0.001, 0.001, -radius + 0.001);
  const high = position.offset(radius - 0.001, height - 0.001, radius - 0.001);
  for (let x = Math.floor(low.x); x <= Math.floor(high.x); x++)
    for (let y = Math.floor(low.y); y <= Math.floor(high.y); y++)
      for (let z = Math.floor(low.z); z <= Math.floor(high.z); z++) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) continue;
        if (
          block.shapes.some(
            ([x0, y0, z0, x1, y1, z1]) =>
              low.x < x + x1 &&
              high.x > x + x0 &&
              low.y < y + y1 &&
              high.y > y + y0 &&
              low.z < z + z1 &&
              high.z > z + z0,
          )
        )
          return block;
      }
  return null;
}

/** The next swim stroke can hit an adjacent rock even when the center is water. */
export function swimmingRoof(bot: Bot): ReturnType<Bot["blockAt"]> {
  return obstruction(bot, bot.entity.position.offset(0, 0.5, 0));
}

// What a rising body passes through as water: still or falling water, and the
// plants that grow in it. A bubble column is left to a route, since one over
// magma pulls down.
const WATER_COLUMN = new Set(["water", "kelp", "kelp_plant", "seagrass", "tall_seagrass"]);

/**
 * Where rising alone reaches air: the column over the body's own cell holds
 * water up to an open cell. Returns the cell's centre at body height, since
 * centring there clears a shoulder caught under an overhang beside the column
 * (OffsetDiver's deepslate, LowAirDiver's bedrock); null when anything solid
 * or lava closes the column, and a route has to find the air.
 */
export function risingReachesAir(bot: Bot): Vec3 | null {
  const feet = bot.entity.position.floored();
  for (let dy = 1; dy <= 32; dy++) {
    const block = bot.blockAt(feet.offset(0, dy, 0));
    if (!block) return null;
    if (WATER_COLUMN.has(block.name)) continue;
    return block.boundingBox === "empty" && block.name !== "lava"
      ? new Vec3(feet.x + 0.5, bot.entity.position.y, feet.z + 0.5)
      : null;
  }
  return null;
}
