import type { Bot } from "mineflayer";
import { projectileReachesBody } from "../../positioning/combat/exposure.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Small fireballs keep their heading while accelerating; test the incoming ray against the body. */
export function isIncomingBlazeProjectile(bot: Bot, projectile: Entity, movementAllowance = 0): boolean {
  if (projectile.name !== "small_fireball" || !projectile.isValid) return false;
  // A movement warning can include the nearby cells the body may enter before
  // it stops. The default remains the physical hitbox for stationary combat.
  return projectileReachesBody(bot.world, projectile, {
    position: bot.entity.position,
    width: bot.entity.width + movementAllowance * 2,
    height: bot.entity.height,
  });
}

export function incomingBlazeProjectiles(bot: Bot, movementAllowance = 0): Entity[] {
  // Distance alone turned away from a fast approaching shot toward a fresh,
  // slower crossfire. This ranks the observed trajectories; acceleration and
  // packet delay mean the quotient is not a promised impact timestamp.
  const travelTime = (entity: Entity) => entity.position.distanceTo(bot.entity.position) / entity.velocity.norm();
  return Object.values(bot.entities)
    .filter((entity) => isIncomingBlazeProjectile(bot, entity, movementAllowance))
    .sort((a, b) => travelTime(a) - travelTime(b));
}
