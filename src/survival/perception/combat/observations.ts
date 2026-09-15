import type { Bot, BotEvents } from "mineflayer";
import { SHIELD_READY_TICKS } from "../../weapons/item-use.js";
import { entityDimensions } from "../../../world/entity-dimensions.js";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import type { PositionThreat } from "../../positioning/combat/exposure.js";
import { bowDrawAimedAtBot, isDrawingBow } from "./attention.js";
import { incomingBlazeProjectiles, isIncomingBlazeProjectile } from "./blaze-projectiles.js";
import { readProjectileSpawn } from "./projectile-spawn.js";
import { isCreeper } from "./creepers.js";
import { canBeBystander, isHostile } from "./threats.js";
import { trackArrowFlights } from "./arrow-flight.js";
import { bowReleaseInTicks, trackBowDraws } from "./bow-timing.js";
import { CreeperClearance } from "./creepers.js";
type Entity = Parameters<Bot["attack"]>[0];
const RANGED_SPECIES = new Set(["blaze"]);
const BLAZE_CHARGING_FLAG = 1;
const BLAZE_MELEE_RANGE = 2;
/** Vanilla's first blaze shot follows sixty ticks after a newly observed charge. */
const BLAZE_CHARGE_TICKS = 60;
function hasBow(entity: Entity): boolean {
  return entity.heldItem?.name === "bow";
}

function blazeCharged(bot: Bot, entity: Entity): boolean | null {
  const index = bot.registry.entitiesByName.blaze?.metadataKeys?.indexOf("flags") ?? -1;
  const flags: unknown = index >= 0 ? entity.metadata?.[index] : undefined;
  return typeof flags === "number" ? (flags & BLAZE_CHARGING_FLAG) !== 0 : null;
}

/** Whether the target shoots: a bow in hand, or a species that shoots by nature. */
export function isRangedAttacker(entity: Entity): boolean {
  return hasBow(entity) || RANGED_SPECIES.has(entity.name ?? "");
}

/**
 * How far a mob can reach the bot from, plus the ground it covers while the
 * shield comes up.
 *
 * Vanilla melee reach is close to the player's own three blocks. The margin is
 * what makes this an observation rather than a report: a shield takes five
 * ticks to activate, an approaching mob covers over a block in that time, and
 * a signal that waited for the exact reach would raise the guard into the
 * swing instead of before it.
 */
const MELEE_REACH = 3;
/**
 * A pursuing mob moves about a quarter of a block a tick, so the allowance is
 * the ground it covers while the shield becomes a shield - rounded up, because
 * being early costs a slower step and being late costs the hit the whole
 * observation exists to stop.
 */
const MOB_CLOSING_SPEED = 0.25;
const MELEE_CLOSING_ALLOWANCE = Math.ceil(SHIELD_READY_TICKS * MOB_CLOSING_SPEED);

/**
 * This hostile can hurt the bot with the next thing it does, hand to hand.
 *
 * The counterpart to `isWindingUp` for everything that does not shoot. Vanilla
 * gives a melee mob no windup to read - no draw, no charge flag, nothing on the
 * wire until the damage packet - so imminence is geometry instead: inside
 * reach, with a body actually exposed to the bot.
 *
 * Head angle is deliberately not part of it. `lookingAtBot` exists to read a
 * bow, where the aim is the shot and a two-byte-angle cone is the evidence; a
 * mob swinging a sword turns within the tick, so where it is looking now says
 * nothing about the next one. Asking it here only invents false negatives -
 * and the two costs are not equal, since a false negative is a hit taken with
 * the shield down while a false positive is a shield raised near a hostile
 * already in reach, which is where it belongs anyway.
 *
 * Without this the only melee observation here was `hasHitUs`, which
 * `entityHurt` sets after the damage. Every guard trigger downstream read a
 * projectile or that flag, so the first swing of every fight was answered
 * rather than blocked: on 2026-09-14 a fortress approach closed on sword-armed
 * wither skeletons with the shield deliberately lowered.
 *
 * Shooters are excluded because their own windup says it earlier and from
 * further out, and a creeper because a raised shield is not the answer to a
 * fuse - blast defence owns that, and needs the hands.
 */
export function meleeImminent(bot: Bot, entity: Entity): boolean {
  if (!isHostile(entity) || canBeBystander(bot, entity) || isCreeper(entity)) return false;
  if (isRangedAttacker(entity) || hasBow(entity)) return false;
  if (entity.position.distanceTo(bot.entity.position) > MELEE_REACH + MELEE_CLOSING_ALLOWANCE) return false;
  return hasExposedBody(bot, entity);
}

/**
 * The same charge or draw as `isWindingUp`, aimed at this bot.
 *
 * `observeProjectileDefence` kept its own copy of this question and answered it
 * with a bow test alone, so a charging blaze - which holds nothing - raised no
 * defence until its fireball existed. One definition, asked two ways: whether
 * the mob is winding up, and whether the bot is what it is winding up at.
 */
export function isWindingUpAtBot(bot: Bot, entity: Entity): boolean {
  if (hasBow(entity)) return bowDrawAimedAtBot(bot, entity);
  return isWindingUp(bot, entity);
}

/**
 * The target's projectile is on its way: the server's living-entity metadata
 * says this bow holder is drawing, or a blaze's own flag says it is charging.
 */

export function isWindingUp(bot: Bot, entity: Entity): boolean {
  if (hasBow(entity)) {
    return isDrawingBow(bot, entity);
  }
  if (entity.name === "blaze") {
    if (entity.position.distanceTo(bot.entity.position) <= BLAZE_MELEE_RANGE) return false;
    return blazeCharged(bot, entity) === true;
  }
  return false;
}

export function positionThreat(bot: Bot, entity: Entity): PositionThreat {
  const projectile = entity.name === "blaze" || entity.heldItem?.name === "bow" || entity.heldItem?.name === "crossbow";
  // These modes are not stopped by a sight-line claim alone. Leave their
  // existing responses in charge until the cover contract models them.
  const unmodelled = [
    "creeper",
    "ghast",
    "vex",
    "evoker",
    "guardian",
    "elder_guardian",
    "wither",
    "ender_dragon",
    "shulker",
    "witch",
  ].includes(entity.name ?? "");
  return {
    id: entity.id,
    position: entity.position.clone(),
    ...entityDimensions(bot, entity),
    attack: unmodelled ? "unmodelled" : projectile ? "projectile" : "melee",
  };
}

export interface ObservedThreat extends PositionThreat {
  readonly entity: Entity;
  readonly distance: number;
  readonly bearing: number;
  readonly visible: boolean;
  readonly windingUp: boolean;
  /** Null if the start was not observed; zero once its first shot can be due. */
  readonly firstShotInTicks: number | null;
  readonly lastSeenTick: number | null;
  readonly lastShotTick: number | null;
  readonly phase: "winding_up" | "shot_observed" | "unknown";
  /** Hand to hand, this one can hurt the bot with its next action. */
  readonly meleeImminent: boolean;
  readonly hasHitUs: boolean;
}

/** Packet facts belong to this connection; consumers share one lazy table per physics tick. */
export class CombatPerception implements Disposable {
  readonly creeperClearance: CreeperClearance;
  get tick(): number { return this.#tick; }
  readonly resolvedIds = new Set<number>();
  readonly attackerIds = new Set<number>();
  readonly #owners = new Map<number, number>();
  readonly #lastSeen = new Map<number, number>();
  readonly #lastShot = new Map<number, number>();
  readonly #charges = new Map<number, { entity: Entity; charged: boolean | null; startedAt: number | null }>();
  #tick = 0;
  #snapshot: readonly ObservedThreat[] | null = null;
  #incoming: Entity[] | null = null;
  readonly #listeners = new DisposableStack();

  constructor(readonly bot: Bot) {
    this.creeperClearance = new CreeperClearance(bot);
    const invalidate = () => {
      this.#snapshot = null;
      this.#incoming = null;
    };
    const tick = () => {
      this.#tick++;
      invalidate();
      for (const [id, owner] of this.#owners) {
        const projectile = bot.entities[id];
        if (projectile && isIncomingBlazeProjectile(bot, projectile)) this.attackerIds.add(owner);
      }
    };
    const hurt: BotEvents["entityHurt"] = (entity, source) => {
      if (isHostile(source)) {
        if (entity.id === bot.entity.id) this.attackerIds.add(source.id);
        // Neutral Endermen can switch to the dragon or another victim. Their
        // anger flag cannot keep an old bot-target attribution alive.
        else if (source.name === "enderman") this.attackerIds.delete(source.id);
      }
      invalidate();
    };
    const gone: BotEvents["entityGone"] = (entity) => {
      for (const set of [this.resolvedIds, this.attackerIds]) set.delete(entity.id);
      this.#owners.delete(entity.id);
      this.#lastSeen.delete(entity.id);
      this.#lastShot.delete(entity.id);
      this.#charges.delete(entity.id);
      invalidate();
    };
    const dead: BotEvents["entityDead"] = (entity) => {
      this.resolvedIds.add(entity.id);
      this.creeperClearance.resolve(entity.id);
      invalidate();
    };
    const shot = (packet: unknown) => {
      const spawn = readProjectileSpawn(bot, packet);
      if (!spawn) return;
      if (spawn.ownerId !== null) {
        this.#owners.set(spawn.projectileId, spawn.ownerId);
        this.#lastShot.set(spawn.ownerId, this.#tick);
      }
      // Remove when Mineflayer retains the 1.21.4 spawn packet's initial velocity.
      bot.entities[spawn.projectileId]?.velocity.update(spawn.velocity);
      invalidate();
    };
    bot.on("physicsTick", tick);
    this.#listeners.defer(() => bot.off("physicsTick", tick));
    bot.on("entitySpawn", invalidate);
    this.#listeners.defer(() => bot.off("entitySpawn", invalidate));
    bot.on("entityHurt", hurt);
    this.#listeners.defer(() => bot.off("entityHurt", hurt));
    bot.on("entityGone", gone);
    this.#listeners.defer(() => bot.off("entityGone", gone));
    bot.on("entityDead", dead);
    this.#listeners.defer(() => bot.off("entityDead", dead));
    const explosion = (packet: unknown) => this.creeperClearance.exploded(packet, this.#tick);
    bot._client.on("explosion", explosion);
    this.#listeners.defer(() => bot._client.off("explosion", explosion));
    const respawn = () => this.creeperClearance.reset();
    bot.on("respawn", respawn);
    this.#listeners.defer(() => bot.off("respawn", respawn));
    bot._client.on("spawn_entity", shot);
    this.#listeners.defer(() => bot._client.off("spawn_entity", shot));
    this.#listeners.use(trackArrowFlights(bot));
    this.#listeners.use(trackBowDraws(bot));
  }

  incoming(): readonly Entity[] {
    return (this.#incoming ??= incomingBlazeProjectiles(this.bot));
  }

  private firstShotInTicks(entity: Entity): number | null {
    if (entity.name !== "blaze") return bowReleaseInTicks(this.bot, entity);
    const charged = blazeCharged(this.bot, entity);
    const previous = this.#charges.get(entity.id);
    const startedAt =
      charged !== true || previous?.entity !== entity
        ? null
        : previous.charged === false
          ? this.#tick
          : previous.startedAt;
    this.#charges.set(entity.id, { entity, charged, startedAt });
    // Hidden time spends the charge too. A stale flag, a target entering
    // melee, or a fresh combat owner cannot buy another sixty-tick window.
    return startedAt === null ? null : Math.max(0, BLAZE_CHARGE_TICKS - (this.#tick - startedAt));
  }

  read(): readonly ObservedThreat[] {
    return (this.#snapshot ??= Object.values(this.bot.entities)
      .filter(
        (entity) =>
          entity.isValid &&
          !this.resolvedIds.has(entity.id) &&
          (entity.position.distanceTo(this.bot.entity.position) <= 32 ||
            this.attackerIds.has(entity.id) ||
            bowDrawAimedAtBot(this.bot, entity)) &&
          entity.id !== this.bot.entity.id &&
          entity.name !== "small_fireball",
      )
      .map((entity): ObservedThreat => {
        let seen: boolean | null = null;
        const visible = () => {
          seen ??= hasExposedBody(this.bot, entity);
          if (seen) this.#lastSeen.set(entity.id, this.#tick);
          return seen;
        };
        const offset = entity.position.minus(this.bot.entity.position);
        const angle = Math.atan2(-offset.x, -offset.z) - this.bot.entity.yaw;
        const windingUp = isWindingUp(this.bot, entity);
        const lastShotTick = this.#lastShot.get(entity.id) ?? null;
        const seenTick = () => {
          visible();
          return this.#lastSeen.get(entity.id) ?? null;
        };
        return {
          ...positionThreat(this.bot, entity),
          entity,
          get visible() {
            return visible();
          },
          windingUp,
          firstShotInTicks: this.firstShotInTicks(entity),
          distance: offset.norm(),
          bearing: Math.atan2(Math.sin(angle), Math.cos(angle)),
          get lastSeenTick() {
            return seenTick();
          },
          lastShotTick,
          meleeImminent: meleeImminent(this.bot, entity),
          // Without sight a blaze can retain its charge indefinitely. No inferred cooldown promise.
          phase: windingUp ? "winding_up" : lastShotTick === this.#tick ? "shot_observed" : "unknown",
          hasHitUs: this.attackerIds.has(entity.id),
        };
      }));
  }

  [Symbol.dispose](): void {
    this.#listeners.dispose();
  }
}
