import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observedEyeHeight, STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import { clearCombatRay } from "../../world/entity-geometry.js";
import { hasExposedBody } from "../../world/entity-visibility.js";
import { arrowImpact, incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { isWindingUpAtBot } from "../perception/combat/observations.js";
import { canBeBystander, isHostile } from "../perception/combat/threats.js";
import { MELEE_RANGE } from "./equipment.js";
import { arrowFlight } from "../perception/combat/arrow-flight.js";
import { bowReleaseInTicks } from "../perception/combat/bow-timing.js";
import { meleeDistance } from "./melee.js";

type Entity = Parameters<Bot["attack"]>[0];
const GUARD_COSINE = Math.cos((70 * Math.PI) / 180);
// Allow a movement-packet send and the server's separate head update before contact.
export const HEAD_TURN_LEAD_TICKS = 3;
const IMPACT_GRACE_TICKS = 2;
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
  const { heading } = shieldCoverage(
    bot.entity.position,
    threats.map((entity) => entity.position),
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
  // Vanilla skeleton arrows launch at 1.6 blocks/tick. Before release this is
  // an estimate: aim/spread and travel change. Observed flight replaces it.
  const windupForecasts = windingUp.map((entity) => ({ entity,
    releaseInTicks: bowReleaseInTicks(bot, entity),
    impactInTicks: (bowReleaseInTicks(bot, entity) ?? 0) + entity.position.distanceTo(bot.entity.position) / 1.6,
  })).sort((a, b) => a.impactInTicks - b.impactInTicks);
  const urgent = forecasts[0];
  // An earlier observed collision can supersede a held later shot. A new bow
  // draw cannot steal the heading during an already committed impact window.
  if (held && urgent && urgent.entity !== held.entity &&
      (!hits.includes(held.entity) || now + urgent.impactInTicks * 50 < held.impactAt - 50)) {
    heldImpacts.delete(bot);
    held = undefined;
  }
  const directions = [...forecasts.map(({ contact, impactInTicks }) => ({ position: contact, impactInTicks })),
    ...windupForecasts.map(({ entity, impactInTicks }) => ({ position: entity.position, impactInTicks }))]
    .sort((a, b) => a.impactInTicks - b.impactInTicks).map(({ position }) => position);
  let { heading, coversAll } = shieldCoverage(
    bot.entity.position,
    directions,
  );
  if (!held && urgent && (urgent.entity.name === "arrow" || urgent.entity.name === "spectral_arrow") &&
      hits.includes(urgent.entity) && urgent.impactInTicks <= HEAD_TURN_LEAD_TICKS) {
    // Cover imminent contacts without sacrificing their margin to a distant
    // shooter. Keep that heading while the server completes this impact.
    heading = shieldCoverage(bot.entity.position,
      forecasts.filter((shot) => shot.impactInTicks <= urgent.impactInTicks + HEAD_TURN_LEAD_TICKS).map((shot) => shot.contact)).heading;
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
      const shared = shieldCoverage(bot.entity.position, contacts);
      if (shared.coversAll) held.heading = shared.heading;
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

/** The same guard cone drives facing and decides whether a shield can answer the exposed firing lines. */
export function shieldCoverage(origin: Vec3, positions: readonly Vec3[]): { heading: Vec3; coversAll: boolean } {
  const directions = positions.map((position) => {
    const toward = position.minus(origin);
    toward.y = 0;
    return toward.norm() === 0 ? new Vec3(0, 0, 1) : toward.normalize();
  });
  const priority = directions[0];
  if (!priority) return { heading: new Vec3(0, 0, 1), coversAll: true };
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
  return { heading, coversAll: covered(heading) === directions.length };
}
