import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BlockPosition, Position3 } from "../navigation/world/world.js";

type ObservedEntity = Parameters<Bot["attack"]>[0];

/** Decode the registry-owned metadata layout at the Mineflayer boundary. */
export function entityMetadata(bot: Bot, entity: ObservedEntity, key: string): unknown {
  const index = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf(key) ?? -1;
  return index < 0 ? undefined : entity.metadata[index];
}

export function dragonPhase(bot: Bot, dragon: ObservedEntity): number | null {
  const phase = entityMetadata(bot, dragon, "phase");
  return typeof phase === "number" ? phase : null;
}

export function entityHealth(bot: Bot, entity: ObservedEntity): number | null {
  const health = entityMetadata(bot, entity, "health");
  return typeof health === "number" ? health : null;
}

export function isDragonPerched(phase: number | null): boolean {
  return phase === 5 || phase === 6 || phase === 7;
}

export function isDragonLanding(phase: number | null): boolean {
  return phase === 2 || phase === 3;
}

const landingCenters = new WeakMap<Bot, { dimension: string; position: Vec3 }>();

/** Recognise the loaded fountain's pillar and rim, not a seed-specific height
 * or the bedrock pedestal on a crystal tower. The heightmap landing target is
 * the bottom centre of the block above the four-block central pillar. */
export function observedDragonLandingCenter(bot: Bot): Vec3 | null {
  const fountainAt = (base: Vec3) =>
    [0, 1, 2, 3].every(y => bot.blockAt(base.offset(0, y, 0))?.name === "bedrock") &&
    [[3, 0], [-3, 0], [0, 3], [0, -3]].every(
      ([x, z]) => bot.blockAt(base.offset(x!, 0, z!))?.name === "bedrock",
    );
  const cached = landingCenters.get(bot);
  if (cached?.dimension === bot.game.dimension &&
      fountainAt(cached.position.offset(-0.5, -4, -0.5)))
    return cached.position.clone();
  landingCenters.delete(bot);
  const bedrock = bot.registry.blocksByName.bedrock;
  if (!bedrock) return null;
  for (const base of bot.findBlocks({ matching: bedrock.id, maxDistance: 128, count: 256 })) {
    if (fountainAt(base)) {
      const position = base.offset(0.5, 4, 0.5);
      landingCenters.set(bot, { dimension: bot.game.dimension, position });
      return position.clone();
    }
  }
  return null;
}

/** The landing target is known terrain; head direction can still change while
 * scanning. This is a preparation hint, never a melee or collision target. */
export function predictedLandingHeadPosition(bot: Bot, dragon: ObservedEntity): Vec3 | null {
  if (!isDragonLanding(dragonPhase(bot, dragon))) return null;
  return observedDragonLandingCenter(bot)?.offset(Math.sin(dragon.yaw) * 6.5, -1, Math.cos(dragon.yaw) * 6.5) ?? null;
}

/** Keep the eyes within melee reach and the standing body below head contact.
 * Rounding downward put fractional native perches outside reach in the full fight. */
export function perchAttackCell(head: Position3): BlockPosition {
  return { x: Math.floor(head.x), y: Math.ceil(head.y) - 4, z: Math.floor(head.z) };
}

/** Position-only geometry is also used in navigation; it does not manufacture an attack entity. */
export function perchedDragonHeadPosition(bot: Bot, dragon: ObservedEntity): Vec3 | null {
  if (!isDragonPerched(dragonPhase(bot, dragon))) return null;
  return dragon.position.offset(Math.sin(dragon.yaw) * 6.5, -1, Math.cos(dragon.yaw) * 6.5);
}

/**
 * Mineflayer does not instantiate dragon parts. Vanilla 1.21.4 assigns the head
 * parent ID + 1. A settled sitting dragon places it 6.5 blocks along its facing
 * axis and one block below its origin (EnderDragon.tickPart/getHeadYOffset).
 * This is a perch-only estimate, not flight geometry: the server's turn/history
 * terms are not transmitted. Callers must leave reach margin and observe damage.
 * Remove this adapter when Mineflayer owns multipart entity observations.
 */
export function perchedDragonHead(bot: Bot, dragon: ObservedEntity): ObservedEntity | null {
  const position = perchedDragonHeadPosition(bot, dragon);
  if (position === null) return null;
  const head: ObservedEntity = Object.assign(Object.create(Object.getPrototypeOf(dragon)), dragon);
  head.id = dragon.id + 1;
  head.name = "ender_dragon_head";
  head.width = 1;
  head.height = 1;
  head.position = position;
  head.isValid = dragon.isValid;
  return head;
}

/** Sitting multipart geometry from vanilla 1.21.4 EnderDragon.tickPart.
 * Tails require unsent flight history, so do not offer them as route endpoints.
 * Like the head, these are estimates: retain reach margin and damage receipts.
 */
export function perchedDragonBodyParts(bot: Bot, dragon: ObservedEntity): ObservedEntity[] {
  if (!isDragonPerched(dragonPhase(bot, dragon))) return [];
  const forwardX = Math.sin(dragon.yaw), forwardZ = Math.cos(dragon.yaw);
  const parts = [
    { name: "neck", id: 2, width: 3, height: 3, position: dragon.position.offset(forwardX * 5.5, -1, forwardZ * 5.5) },
    { name: "body", id: 3, width: 5, height: 3, position: dragon.position.offset(forwardX * 0.5, 0, forwardZ * 0.5) },
    ...[-1, 1].map((side, index) => ({ name: `wing${index + 1}`, id: 7 + index, width: 4, height: 2,
      position: dragon.position.offset(Math.cos(dragon.yaw) * 4.5 * side, 2, -Math.sin(dragon.yaw) * 4.5 * side) })),
  ];
  return parts.map(part => Object.assign(Object.create(Object.getPrototypeOf(dragon)), dragon, part,
    { id: dragon.id + part.id, name: `ender_dragon_${part.name}` }));
}
