import type { Bot } from "mineflayer";
import { dayPhase } from "../../../world/daylight.js";
import { entityMetadata } from "../../../world/end-fight.js";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import { type CombatContact } from "../../policy/combat/decision.js";
import type { HostileThreat } from "../../policy/combat/response.js";
import { bowDrawAimedAtBot, lookingAtBot } from "./attention.js";
import { type CombatPerception } from "./observations.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Baritone's default hostile-avoidance radius, used here as the contact boundary. */
export const HOSTILE_CONTACT_RANGE = 8;
/** Nearby hostiles gathered into the same response after one crosses contact range. */
export const HOSTILE_OBSERVATION_RANGE = 16;
/**
 * minecraft-data's category for every mob that attacks on sight. Mineflayer
 * exposes it as `entity.kind`. The narrower `entity.type === "hostile"` test
 * missed phantoms, slimes, magma cubes, and ghasts, whose type is `mob`, and
 * hoglins, whose type is `animal`.
 */
const HOSTILE_KIND = "Hostile mobs";
/**
 * Hostile by category, but a threat only once provoked. An enderman stares
 * until it is looked at or struck; a zombified piglin ignores everyone until
 * one of them is hit. Neither interrupts work by standing nearby; both do the
 * moment evidence identifies this bot as their victim. An angry Enderman
 * looking at our body gives warning before the first hit; anger alone may
 * instead be directed at the dragon.
 *
 * A piglin belongs here for a different reason. An adult will usually attack a
 * bot carrying no gold, and is fought the moment it does. But striking first
 * buys nothing and costs the whole group: killing any piglin turns every one
 * that can see it, and brutes come with them and ignore gold. Worse, a baby
 * piglin never attacks anybody, and Mineflayer names it `piglin` like the
 * adults, so nothing here can tell them apart. Observed live on 2026-09-04:
 * the bot closed on two piglins that had not touched it, killed both without
 * taking a scratch, and angered a bastion of forty-eight.
 *
 * A spider is neutral by the same rule but only in daylight, which
 * `passiveInDaylight` decides rather than a name in this set.
 */
const NEUTRAL_UNTIL_PROVOKED = new Set(["enderman", "zombified_piglin", "piglin"]);
/**
 * Sky light at or above which vanilla stops a spider attacking on sight.
 *
 * The 2026-09-04 session spent a whole morning below the hide bar because a
 * spider standing in the open at fifteen blocks kept the trigger armed: it is
 * a hostile by Mineflayer's category whatever the sun is doing.
 */
export const SPIDER_PASSIVE_SKY_LIGHT = 12;

/** What the reflex has learned that a distance alone cannot say. */
export interface HostileKnowledge {
  /** Runtime callers share cached exposure with the engagement and recorder. */
  readonly perception?: Pick<CombatPerception, "read">;
  /** Targets already killed whose dying entities are still loaded. */
  readonly resolvedIds: ReadonlySet<number>;
  /** Hostiles observed attacking this bot, through damage or an incoming owned projectile. */
  readonly attackerIds: ReadonlySet<number>;
}

const NO_CONTEXT: HostileKnowledge = {
  resolvedIds: new Set(),
  attackerIds: new Set(),
};

export function isHostile(entity: Entity | undefined): entity is Entity {
  return entity?.kind === HOSTILE_KIND && entity.isValid;
}

/** The mob aggressive bit observes aggression, not the identity of its target. */
function isAggressivePiglin(bot: Bot, entity: Entity): boolean {
  if (entity.name !== "piglin") return false;
  const index = bot.registry.entitiesByName["piglin"]?.metadataKeys?.indexOf("mob_flags") ?? -1;
  const flags: unknown = index >= 0 ? entity.metadata?.[index] : undefined;
  return typeof flags === "number" && (flags & 4) !== 0;
}
/** Anger plus a head look intersecting our body is a pre-hit targeting cue.
 * Allow two byte-angle steps for packet quantisation and staggered updates.
 * This infers attention, not a server-provided target identity.
 */
function angryEndermanLookingAtBot(bot: Bot, entity: Entity): boolean {
  if (entity.name !== "enderman" || entityMetadata(bot, entity, "creepy") !== true) return false;
  return lookingAtBot(bot, entity, 2.55);
}
/**
 * A spider vanilla would not send at the bot: day by the clock, and its own
 * cell lit by the sky at the level at which spiders stop attacking on sight.
 *
 * Sky light rather than the combined light level, because a torch does not
 * make a spider passive and daylight is the whole of the rule. Mineflayer
 * reports `skyLight` per cell from the same chunk data the server sent, so a
 * spider under a roof or down a shaft at noon stays a threat.
 */
function passiveInDaylight(bot: Bot, entity: Entity): boolean {
  if (entity.name !== "spider") return false;
  if (dayPhase(bot.time.timeOfDay) !== "day") return false;
  return (bot.blockAt(entity.position)?.skyLight ?? 0) >= SPIDER_PASSIVE_SKY_LIGHT;
}

/** Players, passive mobs and species that may be neutral must not be swept into another target's fight. */
export function canBeBystander(bot: Bot, entity: Entity): boolean {
  return (
    entity.isValid &&
    (entity.type === "player" ||
      entity.name === "armor_stand" ||
      entity.kind === "Passive mobs" ||
      NEUTRAL_UNTIL_PROVOKED.has(entity.name ?? "") ||
      passiveInDaylight(bot, entity))
  );
}

/**
 * A hostile worth responding to: not already resolved, and not a neutral that
 * has left the bot alone.
 *
 * This is the one answer to "is that thing a threat right now", and everything
 * that needs the answer asks here. The exported `isHostile` beside it is only
 * the Mineflayer category check; a second list of species anywhere else would
 * be a second policy that drifts from this one.
 */
export function isThreat(
  bot: Bot,
  entity: Entity | undefined,
  context: Pick<HostileKnowledge, "resolvedIds" | "attackerIds">,
): entity is Entity {
  return hostileRelationship(bot, entity, context).defend;
}

/** Anger, attention and attack authorization are distinct observations. */
export function hostileRelationship(
  bot: Bot,
  entity: Entity | undefined,
  context: Pick<HostileKnowledge, "resolvedIds" | "attackerIds">,
): CombatContact["relationship"] {
  if (!isHostile(entity) || context.resolvedIds.has(entity.id))
    return { avoid: false, defend: false, attention: "unknown" };
  if (context.attackerIds.has(entity.id)) return { avoid: true, defend: true, attention: "observed_attack" };
  if (angryEndermanLookingAtBot(bot, entity)) return { avoid: true, defend: true, attention: "inferred_head_gaze" };
  if (!canBeBystander(bot, entity)) return { avoid: true, defend: true, attention: "on_sight" };
  return { avoid: isAggressivePiglin(bot, entity), defend: false, attention: "unknown" };
}
/** Aggression without an observed victim warrants avoidance, never attack authorization. */
export function shouldAvoidEntity(bot: Bot, entity: Entity | undefined, context: HostileKnowledge): entity is Entity {
  return hostileRelationship(bot, entity, context).avoid;
}

/**
 * Whether any relevant hostile is in contact, without building the threat list.
 *
 * The reflex asks every physics tick, almost always with nothing nearby, so the
 * common answer must not allocate a sorted list of positions to say no.
 */
function exposed(bot: Bot, entity: Entity, context: HostileKnowledge): boolean {
  return context.perception
    ? context.perception.read().find((entry) => entry.id === entity.id)?.visible === true
    : hasExposedBody(bot, entity);
}

/** Observe nearby hostiles and actual attackers, including those shooting from beyond passive observation range. */
export function observeHostileContact(bot: Bot, context: HostileKnowledge = NO_CONTEXT): readonly HostileThreat[] {
  return describeContact(
    bot,
    Object.values(bot.entities).filter((entity) => isThreat(bot, entity, context)),
    context,
  );
}
function describeContact(bot: Bot, entities: readonly Entity[], context: HostileKnowledge): readonly HostileThreat[] {
  return entities
    .map((entity) => ({
      id: entity.id,
      name: entity.name ?? entity.displayName ?? "hostile",
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      distance: entity.position.distanceTo(bot.entity.position),
    }))
    .filter(
      (threat) =>
        threat.distance <= HOSTILE_OBSERVATION_RANGE ||
        context.attackerIds.has(threat.id) ||
        bowDrawAimedAtBot(bot, bot.entities[threat.id]!),
    )
    .sort((left, right) => left.distance - right.distance || left.id - right.id);
}

/** Nearby relevant threats whose bodies are currently exposed to the bot. */
export function observeExposedAvoidanceContact(bot: Bot, context: HostileKnowledge): readonly HostileThreat[] {
  return describeContact(
    bot,
    Object.values(bot.entities).filter((entity) => shouldAvoidEntity(bot, entity, context)),
    context,
  ).filter((threat) => {
    const entity = bot.entities[threat.id];
    return entity !== undefined && exposed(bot, entity, context);
  });
}

/**
 * Hostile by species, decided from the registry rather than from a loaded entity.
 *
 * Callers that must judge a species before anything of it is loaded - an
 * admission check on a requested mob name - cannot read `entity.kind`, but the
 * category behind that field is in the registry under the same name. The
 * narrower `type` field is not the same test: it calls a hoglin an animal and a
 * phantom, slime, magma cube or ghast a plain mob.
 */
export function isHostileSpecies(bot: Pick<Bot, "registry">, mobName: string): boolean {
  return bot.registry.entitiesByName[mobName]?.category === HOSTILE_KIND;
}
