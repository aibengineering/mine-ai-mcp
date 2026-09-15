import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { entityDimensions } from "../../../world/entity-dimensions.js";
import { nearestBodyPoint } from "../../../world/entity-geometry.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Head direction is an inferred target cue; the server does not publish target identity. */
export function lookingAtBot(bot: Bot, entity: Entity, eyeHeight: number): boolean {
  const yaw: unknown = Reflect.get(entity, "headYaw");
  const pitch = entity.pitch;
  if (typeof yaw !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
  const eye = entity.position.offset(0, eyeHeight, 0);
  const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const body = { position: bot.entity.position, ...entityDimensions(bot, bot.entity) };
  const distance = body.position.offset(0, body.height / 2, 0).minus(eye).dot(look);
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

/** No distance cutoff: any loaded bow holder drawing toward our body warrants attention. */
export function bowDrawAimedAtBot(bot: Bot, entity: Entity): boolean {
  if (!isDrawingBow(bot, entity)) return false;
  const observed: unknown = Reflect.get(entity, "eyeHeight");
  const eyeHeight = typeof observed === "number" && Number.isFinite(observed) ? observed : entity.height * 0.85;
  return lookingAtBot(bot, entity, eyeHeight);
}
