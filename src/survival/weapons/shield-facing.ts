import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observedEyeHeight, STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import { clearCombatRay } from "../../world/entity-geometry.js";
import { hasExposedBody } from "../../world/entity-visibility.js";
import { arrowImpact, incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { canBeBystander, isHostile } from "../perception/combat/threats.js";
import { arrowFlight } from "../perception/combat/arrow-flight.js";
import { bowReleaseInTicks } from "../perception/combat/bow-timing.js";
import { projectileContact } from "../perception/combat/exposure.js";
import { meleeDistance, MELEE_RANGE } from "../perception/combat/reach.js";
import { isWindingUpAtBot } from "../perception/combat/observations.js";

type Entity = Parameters<Bot["attack"]>[0];
const GUARD_COSINE = Math.cos((70 * Math.PI) / 180);
// Allow a movement-packet send and the server's separate head update before contact.
export const HEAD_TURN_LEAD_TICKS = 3;
const IMPACT_GRACE_TICKS = 2;
// Vanilla skeleton arrows launch at 1.6 blocks/tick.
const ARROW_LAUNCH_SPEED = 1.6;
const heldImpacts = new WeakMap<Bot, { entity: Entity; heading: Vec3; until: number; impactAt: number }>();

/** A confirmed block ends the estimated contact grace, but does not identify an arrow. */
export function confirmShieldBlock(bot: Bot): void {
  heldImpacts.delete(bot);
}

/** Face a cone covering nearby attackers, rather than exposing one side each time the nearest cube changes. */
export function shieldFacing(bot: Bot, target: Entity, dead: ReadonlySet<number>): Vec3 {
  const projectileFacing = projectileShieldFacing(bot);
  if (projectileFacing) return projectileFacing;
  const threats = Object.values(bot.entities)
    .filter(
      (entity) =>
        entity.id === target.id ||
        (!dead.has(entity.id) &&
          isHostile(entity) &&
          !canBeBystander(bot, entity) &&
          meleeDistance(bot, entity) <= MELEE_RANGE + 1 &&
          hasExposedBody(bot, entity)),
    )
    .sort((a, b) => meleeDistance(bot, a) - meleeDistance(bot, b));
  // Attackers in reach swing without a windup; any of them can land next.
  const { heading } = shieldCoverage(
    bot.entity.position,
    threats.map((entity) => entity.position),
    { withinBlockingArc: true },
  );
  return bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0).plus(heading);
}

/** One shield can cover several incoming shots; keep the most urgent one inside its arc. */
export function projectileShieldFacing(bot: Bot, movementAllowance = 0): Vec3 | null {
  return observeProjectileDefence(bot, movementAllowance)?.facing ?? null;
}

/** One assessment for movement admission, shield aim and guard release. */
export function observeProjectileDefence(bot: Bot, movementAllowance = 0, now = performance.now()) {
  let held = heldImpacts.get(bot);
  if (held && (now >= held.until || !held.entity.isValid)) {
    heldImpacts.delete(bot);
    held = undefined;
  }
  // A crossing shot can warn movement to stop without threatening the settled
  // body. Such a near miss must never take aim priority over an actual hit.
  const hits = incomingShieldProjectiles(bot);
  const projectiles = hits.length ? hits : incomingShieldProjectiles(bot, movementAllowance);
  const windingUp = Object.values(bot.entities).filter((entity) =>
    isHostile(entity) && !canBeBystander(bot, entity) &&
    isWindingUpAtBot(bot, entity) && clearCombatRay(bot.world,
      entity.position.offset(0, observedEyeHeight(entity), 0),
      bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0)));
  if (projectiles.length === 0 && windingUp.length === 0 && !held) return null;
  const forecasts = projectiles.map((entity) => {
    const impact = arrowImpact(bot, entity, hits.length ? 0 : movementAllowance);
    const flight = arrowFlight(bot, entity);
    return { entity,
      impactInTicks: impact?.ticks ?? entity.position.distanceTo(bot.entity.position) / entity.velocity.norm(),
      contact: impact?.position ?? flight.position,
    };
  }).sort((a, b) => a.impactInTicks - b.impactInTicks);
  // Before release this is an estimate: aim/spread and travel change.
  // Observed flight replaces it.
  const windupForecasts = windingUp.map((entity) => {
    const flightTicks = entity.position.distanceTo(bot.entity.position) / ARROW_LAUNCH_SPEED;
    return { entity,
      releaseInTicks: bowReleaseInTicks(bot, entity),
      impactInTicks: (bowReleaseInTicks(bot, entity) ?? 0) + flightTicks,
      contact: entity.heldItem?.name === "bow" ? drawnArrowContact(bot, entity, flightTicks) : entity.position,
    };
  }).sort((a, b) => a.impactInTicks - b.impactInTicks);
  const urgent = forecasts[0];
  // An earlier observed collision can supersede a held later shot. A new bow
  // draw cannot steal the heading during an already committed impact window.
  if (held && urgent && urgent.entity !== held.entity &&
      (!hits.includes(held.entity) || now + urgent.impactInTicks * 50 < held.impactAt - 50)) {
    heldImpacts.delete(bot);
    held = undefined;
  }
  const directions = [...forecasts.map(({ contact, impactInTicks }) => ({ position: contact, impactInTicks })),
    ...windupForecasts.map(({ contact, impactInTicks }) => ({ position: contact, impactInTicks }))]
    .sort((a, b) => a.impactInTicks - b.impactInTicks).map(({ position }) => position);
  let { heading, coversAll } = shieldCoverage(
    bot.entity.position,
    directions,
  );
  if (!held && urgent && (urgent.entity.name === "arrow" || urgent.entity.name === "spectral_arrow") &&
      hits.includes(urgent.entity) && urgent.impactInTicks <= HEAD_TURN_LEAD_TICKS) {
    // Cover imminent contacts without sacrificing their margin to a distant
    // shooter. Keep that heading while the server completes this impact.
    // Contacts landing within the turn horizon of each other cannot be faced
    // in turn; hold a heading that blocks them all if vanilla's arc allows.
    heading = shieldCoverage(bot.entity.position,
      forecasts.filter((shot) => shot.impactInTicks <= urgent.impactInTicks + HEAD_TURN_LEAD_TICKS).map((shot) => shot.contact),
      { withinBlockingArc: true }).heading;
    held = { entity: urgent.entity, heading, impactAt: now + urgent.impactInTicks * 50,
      until: now + (urgent.impactInTicks + IMPACT_GRACE_TICKS) * 50 };
    heldImpacts.set(bot, held);
  }
  if (held) {
    // A second shot can enter the turn horizon after commitment. Use a shared
    // heading when both contacts fit, rather than waiting to turn after the first.
    const committed = forecasts.find((shot) => shot.entity === held.entity);
    if (committed) {
      const contacts = [committed, ...forecasts.filter((shot) => shot !== committed &&
        shot.impactInTicks <= committed.impactInTicks + HEAD_TURN_LEAD_TICKS)].map((shot) => shot.contact);
      const shared = shieldCoverage(bot.entity.position, contacts, { withinBlockingArc: true });
      if (shared.blocksAll) held.heading = shared.heading;
    }
    heading = held.heading;
  }
  const look = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const unitDirections = directions.map((position) => {
    const direction = position.minus(bot.entity.position);
    direction.y = 0;
    return direction.norm() === 0 ? heading : direction.normalize();
  });
  if (held) unitDirections.unshift(held.heading);
  const covered = (aim: Vec3) => unitDirections.filter((direction) => aim.dot(direction) >= GUARD_COSINE).length;
  coversAll = covered(heading) === unitDirections.length;
  return {
    projectiles: forecasts,
    windingUp,
    windupForecasts,
    heldProjectileId: held?.entity.id ?? null,
    holdRemainingTicks: held ? Math.max(0, (held.until - now) / 50) : 0,
    facing: bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0).plus(heading),
    coversAll,
    // Opposing shooters cannot all fit. Once the urgent shot and the best
    // available coverage are faced, do not repeatedly stop the approach.
    aligned: look.dot(unitDirections[0]!) >= GUARD_COSINE && covered(look) >= covered(heading),
    imminent: hits.length > 0 || held !== undefined,
  };
}

/**
 * Where a drawn bow's arrow will enter this body, relative to where it stands
 * now. Vanilla blocks with a shield when that entry point, on the body's box
 * inflated by 0.3, lies in front of the head yaw the server held on the tick
 * before the hit, whatever direction the shooter stands in. The bow aims at
 * the body as it stands at release, and a walking body keeps moving through
 * the two or three ticks a close shot flies, so the entry point moves round
 * the box against the walk. A standing body gets the shooter's own bearing.
 */
function drawnArrowContact(bot: Bot, shooter: Entity, flightTicks: number): Vec3 {
  const aim = bot.entity.position.offset(0, bot.entity.height / 3, 0);
  const from = new Vec3(shooter.position.x, aim.y, shooter.position.z);
  const velocity = bot.entity.velocity;
  const drift = new Vec3(velocity?.x ?? 0, 0, velocity?.z ?? 0).scaled(Math.ceil(flightTicks));
  const entry = projectileContact(bot.world, { position: from, velocity: aim.minus(from) },
    { position: bot.entity.position.plus(drift), width: bot.entity.width, height: bot.entity.height });
  return entry ? entry.minus(drift) : shooter.position;
}

/**
 * Vanilla 1.21.4 blocks a source anywhere in front of the head yaw: under 90
 * degrees either side, since LivingEntity.isDamageSourceBlocked compares only
 * the source's horizontal direction with the view vector. The 70-degree guard
 * cone keeps a margin for estimated contacts, a mob's step and head-yaw lag.
 * When no heading fits every attacker into that cone, a heading that keeps
 * them all within this wider half-arc still blocks each of them; facing the
 * most urgent alone leaves the others behind the shield for certain.
 */
const BLOCKING_HALF_ARC = (85 * Math.PI) / 180;

/** The centre and half-width of the narrowest arc of bearings holding every direction. */
function enclosingArc(directions: readonly Vec3[]): { center: Vec3; halfSpan: number } {
  const angles = directions.map((direction) => Math.atan2(direction.z, direction.x)).sort((a, b) => a - b);
  let gap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
  let start = angles[0]!;
  for (let index = 1; index < angles.length; index++) {
    const between = angles[index]! - angles[index - 1]!;
    if (between > gap) {
      gap = between;
      start = angles[index]!;
    }
  }
  const halfSpan = (2 * Math.PI - gap) / 2;
  return { center: new Vec3(Math.cos(start + halfSpan), 0, Math.sin(start + halfSpan)), halfSpan };
}

/**
 * The same guard cone drives facing and decides whether a shield can answer the exposed firing lines.
 * `withinBlockingArc` is for contacts that are about to land: when the cone
 * cannot hold them all, face the middle of the narrowest arc that holds them
 * if vanilla's half-arc still blocks every one from there. `blocksAll` says so.
 */
export function shieldCoverage(
  origin: Vec3,
  positions: readonly Vec3[],
  { withinBlockingArc = false }: { readonly withinBlockingArc?: boolean } = {},
): { heading: Vec3; coversAll: boolean; blocksAll: boolean } {
  const directions = positions.map((position) => {
    const toward = position.minus(origin);
    toward.y = 0;
    return toward.norm() === 0 ? new Vec3(0, 0, 1) : toward.normalize();
  });
  const priority = directions[0];
  if (!priority) return { heading: new Vec3(0, 0, 1), coversAll: true, blocksAll: true };
  // The caller orders threats by urgency. The first must stay covered. Among headings
  // that do so, choose the one also covering the most other observed threats.
  const candidates = [...directions];
  for (let a = 0; a < directions.length; a++)
    for (let b = a + 1; b < directions.length; b++) {
      const between = directions[a]!.plus(directions[b]!);
      if (between.norm() > 0.001) candidates.push(between.normalize());
    }
  const covered = (heading: Vec3) => directions.filter((toward) => heading.dot(toward) >= GUARD_COSINE).length;
  let heading = priority;
  for (const candidate of candidates)
    if (candidate.dot(priority) >= GUARD_COSINE && covered(candidate) > covered(heading)) heading = candidate;
  const coversAll = covered(heading) === directions.length;
  if (withinBlockingArc && !coversAll) {
    const arc = enclosingArc(directions);
    if (arc.halfSpan <= BLOCKING_HALF_ARC) heading = arc.center;
  }
  const blocks = Math.cos(BLOCKING_HALF_ARC) - 1e-9;
  return { heading, coversAll, blocksAll: directions.every((toward) => heading.dot(toward) >= blocks) };
}
