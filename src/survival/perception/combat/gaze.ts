import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observedEyeHeight } from "../../../world/block-visibility.js";
/** Vanilla's distance-dependent eye cone, with margin for look quantisation. */
export function endermanGazeRisk(bot: Bot, feet: Vec3, yaw: number, pitch: number, selectedId?: number): boolean {
  if (bot.game.dimension !== "the_end" || bot.inventory.slots[5]?.name === "carved_pumpkin") return false;
  const origin = feet.offset(0, observedEyeHeight(bot.entity), 0);
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  return Object.values(bot.entities).some((entity) => {
    if (!entity.isValid || entity.name !== "enderman" || entity.id === selectedId) return false;
    const delta = entity.position.offset(0, 2.55, 0).minus(origin);
    const distance = delta.norm();
    if (distance === 0 || distance > 64 || look.dot(delta.scaled(1 / distance)) <= 1 - 0.05 / distance) return false;
    return bot.world.raycast(origin, delta.scaled(1 / distance), distance) === null;
  });
}
