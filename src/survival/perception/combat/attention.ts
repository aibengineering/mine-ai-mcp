import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { entityDimensions } from "../../../world/entity-dimensions.js";
import { nearestBodyPoint } from "../../../world/entity-geometry.js";

type Entity = Parameters<Bot["attack"]>[0];

/**
 * Head direction is an inferred target cue; the server does not publish target identity.
 * With `levelPitchUnreported`, a level pitch says nothing about height and
 * only the head's yaw is read: the aim is taken to be the body's centre.
 */
export function lookingAtBot(bot: Bot, entity: Entity, eyeHeight: number, levelPitchUnreported = false): boolean {
  const yaw: unknown = Reflect.get(entity, "headYaw");
  if (typeof yaw !== "number" || !Number.isFinite(yaw) || !Number.isFinite(entity.pitch)) return false;
  const eye = entity.position.offset(0, eyeHeight, 0);
  const body = { position: bot.entity.position, ...entityDimensions(bot, bot.entity) };
  const centre = body.position.offset(0, body.height / 2, 0);
  const pitch = levelPitchUnreported && entity.pitch === 0
    ? Math.atan2(centre.y - eye.y, Math.hypot(centre.x - eye.x, centre.z - eye.z))
    : entity.pitch;
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const distance = centre.minus(eye).dot(look);
  if (distance <= 0) return false;
  const aimed = eye.plus(look.scaled(distance));
  // Two byte-angle steps cover packet quantisation and staggered head updates.
  return nearestBodyPoint(aimed, body).distanceTo(aimed) <= distance * Math.sin((4 * Math.PI) / 256);
}

export function isDrawingBow(bot: Bot, entity: Entity): boolean {
  if (entity.heldItem?.name !== "bow") return false;
  const keys = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys;
  const index = keys?.indexOf("living_entity_flags") ?? 8;
  const flags: unknown = entity.metadata?.[index];
  return typeof flags === "number" && (flags & 1) !== 0;
}

/**
 * No distance cutoff: any loaded bow holder drawing toward our body warrants attention.
 *
 * The server reports a skeleton's pitch as level almost always, wherever it
 * aims: 0 in 15,429 of 15,575 samples recorded in skeleton crossfire on
 * 2026-10-22, with the bot 5 to 35 degrees below. A level line from an eye
 * higher than the bot's head misses the body, so a skeleton knocked into the
 * air or standing a block up drew unseen and shot the bot from behind its
 * shield (skeleton-arena-crossfire, xfire-base t00006). A level pitch is read
 * as no vertical evidence; the head's yaw still decides whom the draw is for.
 */
export function bowDrawAimedAtBot(bot: Bot, entity: Entity): boolean {
  if (!isDrawingBow(bot, entity)) return false;
  const observed: unknown = Reflect.get(entity, "eyeHeight");
  const eyeHeight = typeof observed === "number" && Number.isFinite(observed) ? observed : entity.height * 0.85;
  return lookingAtBot(bot, entity, eyeHeight, true);
}
