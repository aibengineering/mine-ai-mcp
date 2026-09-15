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

/** A short lateral swim needs a clear body corridor and water or footing at its end. */
function clearSwim(bot: Bot, target: Vec3): boolean {
  const start = bot.entity.position;
  const steps = Math.ceil(start.distanceTo(target) / 0.2);
  for (let step = 1; step <= steps; step++) {
    const p = start.plus(target.minus(start).scaled(step / steps));
    if (obstruction(bot, p)) return false;
    for (const dx of [-0.3, 0.3])
      for (const dz of [-0.3, 0.3])
        for (const dy of [0, 1, 1.8]) {
          const block = bot.blockAt(p.offset(dx, dy, dz));
          if (!block || ["lava", "fire", "soul_fire"].includes(block.name)) return false;
        }
  }
  const feet = bot.blockAt(target);
  const floor = bot.blockAt(target.offset(0, -1, 0));
  return feet?.name === "water" || (floor?.boundingBox === "block" && floor.name !== "magma_block");
}

/** Search only the immediately reachable two-block swim, never a blind push off a waterfall. */
export function nearbySwimEscape(bot: Bot, blocked: readonly Vec3[] = []): Vec3 | null {
  const origin = bot.entity.position.floored();
  const candidates: Vec3[] = [];
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++) {
      const target = new Vec3(origin.x + dx + 0.5, bot.entity.position.y, origin.z + dz + 0.5);
      if (blocked.some((point) => point.x === target.x && point.z === target.z)) continue;
      if (obstruction(bot, target.offset(0, 0.5, 0)) || !clearSwim(bot, target)) continue;
      candidates.push(target);
    }
  return candidates.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] ?? null;
}
