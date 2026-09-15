import type { EntityBody } from "../../../world/entity-geometry.js";
import type { Bot } from "mineflayer";
import { PROJECTILE_HIT_MARGIN, projectileContact } from "../../positioning/combat/exposure.js";
import { isIncomingBlazeProjectile } from "./blaze-projectiles.js";
import { arrowFlight } from "./arrow-flight.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Arrows curve under gravity; a straight extension of their launch ray misses future hits. */
export function arrowImpactInTicks(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity): number | null {
  return arrowImpact(bot, arrow, movementAllowance, target)?.ticks ?? null;
}

export function arrowImpact(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity) {
  if (!arrow.isValid || (arrow.name !== "arrow" && arrow.name !== "spectral_arrow")) return null;
  const keys = bot.registry.entitiesByName[arrow.name]?.metadataKeys ?? [];
  const grounded: unknown = arrow.metadata?.[keys.indexOf("in_ground")];
  const piercing: unknown = arrow.metadata?.[keys.indexOf("pierce_level")];
  if (grounded === true || (typeof piercing === "number" && piercing > 0) || arrow.velocity.norm() === 0) return null;
  const body = {
    position: target.position,
    width: target.width + movementAllowance * 2,
    height: target.height,
  };
  let { position, velocity } = arrowFlight(bot, arrow);
  if (velocity.norm() === 0) return null;
  // Horizontal drag cannot reverse an arrow. Stop once it has passed the
  // body's expanded footprint, fallen below it, or hit terrain, rather than
  // predicting an arbitrary number of ticks into the future.
  const half = body.width / 2 + PROJECTILE_HIT_MARGIN;
  // A reflected arrow can still be inside the expanded hit box. Its zero-
  // distance box intersection is not a new incoming hit. Keep vertical falls.
  const towardX = body.position.x - position.x, towardZ = body.position.z - position.z;
  if (Math.abs(towardX) <= half && Math.abs(towardZ) <= half &&
      position.y >= body.position.y - PROJECTILE_HIT_MARGIN &&
      position.y <= body.position.y + body.height + PROJECTILE_HIT_MARGIN &&
      towardX * velocity.x + towardZ * velocity.z < 0) return null;
  for (let ticks = 0; ; ticks++) {
    const dx = body.position.x - position.x,
      dz = body.position.z - position.z;
    if (
      (Math.abs(dx) > half && dx * velocity.x <= 0) ||
      (Math.abs(dz) > half && dz * velocity.z <= 0) ||
      (position.y < body.position.y - PROJECTILE_HIT_MARGIN && velocity.y <= 0)
    )
      return null;
    const speed = velocity.norm();
    const contact = projectileContact(bot.world, { position, velocity }, body, speed);
    if (contact) return { ticks: ticks + 1, position: contact };
    if (speed > 0 && bot.world.raycast(position, velocity.scaled(1 / speed), speed)) return null;
    position = position.plus(velocity);
    // Same native air drag/gravity as the existing bow trajectory solver.
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
}

export function isIncomingArrow(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity): boolean {
  return arrowImpactInTicks(bot, arrow, movementAllowance, target) !== null;
}

/** Shield-facing and retreat admission must consider the same set of blockable shots. */
export function incomingShieldProjectiles(bot: Bot, movementAllowance = 0): Entity[] {
  const travelTime = (entity: Entity) => {
    const state = arrowFlight(bot, entity);
    return state.position.distanceTo(bot.entity.position) / state.velocity.norm();
  };
  return Object.values(bot.entities)
    .filter(
      (entity) =>
        isIncomingBlazeProjectile(bot, entity, movementAllowance) || isIncomingArrow(bot, entity, movementAllowance),
    )
    .sort((a, b) => travelTime(a) - travelTime(b));
}
