import type { Bot } from "mineflayer";
import type { Position3 } from "../../../utils/index.js";
import { STANDING_EYE_HEIGHT, observedEyeHeight } from "../../../world/block-visibility.js";
import { entityDimensions } from "../../../world/entity-dimensions.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Maximum eye-to-body melee reach, shared by ordinary and knockback attacks. */
export const MELEE_RANGE = 3;

/** Reach is measured from the player's eyes to the target's body, including a jumping body's lower face. */
export function meleeDistance(bot: Bot, entity: Entity): number {
  return distanceToBody(
    bot.entity.position,
    { position: entity.position, ...entityDimensions(bot, entity) },
    observedEyeHeight(bot.entity),
  );
}

/** Nearby bodies separated by terrain cannot attack one another. */
/** A jumping cube's temporary height is not a ledge to climb onto. */
export function airborneCube(bot: Bot, entity: Entity): boolean {
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
