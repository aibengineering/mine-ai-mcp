import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { HORIZONTAL_TICKS_PER_BLOCK, hasSupportedCorridor, type Goal, type WorldView } from "../../navigation/index.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { obstaclesOf, worldViewRaycaster } from "../../navigation/world/line-of-sight.js";
import type { Position3 } from "../../utils/index.js";
import { STANDING_EYE_HEIGHT, observedEyeHeight } from "../../world/block-visibility.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { exposedBodyFrom } from "../../world/entity-geometry.js";
import { hasExposedBody } from "../../world/entity-visibility.js";
import { canBeBystander, isHostile } from "../perception/combat/threats.js";
import { MELEE_RANGE, readCombatItems } from "./equipment.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Reach is measured from the player's eyes to the target's body, including a jumping body's lower face. */
export function meleeDistance(bot: Bot, entity: Entity): number {
  return distanceToBody(
    bot.entity.position,
    { position: entity.position, ...entityDimensions(bot, entity) },
    observedEyeHeight(bot.entity),
  );
}

/** Nearby bodies separated by terrain cannot attack one another. */
export function canMeleeTarget(bot: Bot, entity: Entity): boolean {
  return meleeDistance(bot, entity) <= MELEE_RANGE && hasExposedBody(bot, entity);
}

/** A jumping cube's temporary height is not a ledge to climb onto. */
function airborneCube(bot: Bot, entity: Entity): boolean {
  if (entity.name !== "magma_cube" && entity.name !== "slime") return false;
  const { width } = entityDimensions(bot, entity);
  for (let x = Math.floor(entity.position.x - width / 2); x <= Math.floor(entity.position.x + width / 2); x++)
    for (let z = Math.floor(entity.position.z - width / 2); z <= Math.floor(entity.position.z + width / 2); z++) {
      const block = bot.blockAt(entity.position.clone().set(x, entity.position.y - 0.01, z));
      if (!block || block.boundingBox !== "empty") return false;
    }
  return true;
}

export function waitingForDescendingCube(bot: Bot, entity: Entity): boolean {
  if (entity.position.y <= bot.entity.position.y || !airborneCube(bot, entity)) return false;
  const { width } = entityDimensions(bot, entity);
  const dx = Math.max(0, Math.abs(entity.position.x - bot.entity.position.x) - width / 2);
  const dz = Math.max(0, Math.abs(entity.position.z - bot.entity.position.z) - width / 2);
  return Math.hypot(dx, dz) <= MELEE_RANGE && meleeDistance(bot, entity) > MELEE_RANGE;
}

export function distanceToBody(
  feet: Position3,
  body: { position: Position3; width: number; height: number },
  eyeHeight = STANDING_EYE_HEIGHT,
): number {
  const eyeY = feet.y + eyeHeight;
  const dx = Math.max(0, Math.abs(body.position.x - feet.x) - body.width / 2);
  const dz = Math.max(0, Math.abs(body.position.z - feet.z) - body.width / 2);
  const dy = Math.max(0, body.position.y - eyeY, eyeY - body.position.y - body.height);
  return Math.hypot(dx, dy, dz);
}

/** The approach and swing must agree on reach, including targets above or below a ledge. */
export function meleeApproachGoal(bot: Bot, targetId: number, world: WorldView): Goal {
  const rays = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z)));
  return {
    resolve(observation) {
      const entity = bot.entities[targetId];
      if (!entity?.isValid) return { kind: "invalid", observation: `Entity ${targetId} is not currently observed.` };
      const body = { position: entity.position.clone(), ...entityDimensions(bot, entity) };
      // Approach the horizontal footprint of a hopping cube. The controller
      // waits behind its shield until the real body descends into swing reach.
      if (body.position.y > observation.position.y && airborneCube(bot, entity))
        body.position.y = observation.position.y;
      const current = navigationFeet(observation.position, observation.stance === "supported");
      const eyeHeight = observedEyeHeight(bot.entity);
      const positionAt = (feet: Position3) =>
        feet.x === current.x && feet.y === current.y && feet.z === current.z
          ? observation.position
          : { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      const distanceAt = (feet: Position3) => {
        const position = positionAt(feet);
        return distanceToBody(position, body, position === observation.position ? eyeHeight : STANDING_EYE_HEIGHT);
      };
      return {
        kind: "active",
        revision: `melee:${targetId}:${body.position}:${body.width}:${body.height}:${current.x},${current.y},${current.z}:${distanceAt(current) <= MELEE_RANGE}`,
        isSatisfied: (node) => {
          if (distanceAt(node.feet) > MELEE_RANGE) return false;
          const position = positionAt(node.feet);
          const eye = new Vec3(position.x, position.y, position.z).offset(
            0,
            position === observation.position ? eyeHeight : STANDING_EYE_HEIGHT,
            0,
          );
          return (
            exposedBodyFrom(rays, eye, body) &&
            (!isHostile(entity) || hasMeleeKnockbackRoom(world, position, body.position))
          );
        },
        heuristic: (node) => Math.max(0, distanceAt(node.feet) - MELEE_RANGE) * HORIZONTAL_TICKS_PER_BLOCK,
      };
    },
  };
}

/**
 * A melee stance needs landing room opposite the attacker, not just reach.
 * Three blocks cover the displacement seen in the recorded basalt pack hit;
 * this is a checked buffer for ordinary contact, not an explosion guarantee.
 */
export function hasMeleeKnockbackRoom(world: WorldView, position: Position3, attacker: Position3): boolean {
  const dx = position.x - attacker.x;
  const dz = position.z - attacker.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.01) return false;
  return hasSupportedCorridor(world, position, { x: (dx / distance) * 3, y: 0, z: (dz / distance) * 3 });
}

/** Keep a non-sweeping tool available instead of equipping a sword whose swing must be withheld. */
export function combatItemsForTarget(bot: Bot, target: Entity) {
  const carried = readCombatItems(bot);
  return hasSweepBystander(bot, target) ? carried.filter((item) => !item.name.endsWith("_sword")) : carried;
}

/**
 * A grounded sword swing can damage other living entities within three blocks
 * of the player. Exclude a bystander's whole observed body, not only its feet:
 * a moving enderman on a slope was last seen 3.17 blocks away when the server
 * applied the next sword swing to both it and the selected target.
 */
export function hasSweepBystander(bot: Bot, target: Entity): boolean {
  const feet = bot.entity.position;
  return Object.values(bot.entities).some((entity) => {
    if (entity.id === target.id || entity.id === bot.entity.id || !canBeBystander(bot, entity)) return false;
    const halfWidth = entity.width / 2;
    const dx = Math.max(0, Math.abs(entity.position.x - feet.x) - halfWidth);
    const dz = Math.max(0, Math.abs(entity.position.z - feet.z) - halfWidth);
    const dy = Math.max(0, entity.position.y - feet.y, feet.y - entity.position.y - entity.height);
    return Math.hypot(dx, dy, dz) <= MELEE_RANGE;
  });
}
