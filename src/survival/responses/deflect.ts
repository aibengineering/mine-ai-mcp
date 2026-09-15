import type { Bot } from "mineflayer";
import { STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Vanilla 1.21.4 AbstractHurtingProjectile.applyInertia, before each air movement. */
function projectedPosition(target: Entity, ticks: number) {
  let position = target.position.clone();
  let velocity = target.velocity.clone();
  for (let tick = 0; tick < ticks; tick += 1) {
    velocity = velocity.plus(velocity.unit().scaled(0.1)).scaled(0.95);
    position = position.plus(velocity);
  }
  return position;
}
/** Vanilla survival entity interaction reach, measured from the eye to the box. */
const ATTACK_REACH = 3;

/** The caller owns the body; hold the footing and hit back along the incoming trajectory. */
export async function deflectFireball(bot: Bot, targetId: number, signal: AbortSignal) {
  const target = bot.entities[targetId];
  if (!target?.isValid)
    return { kind: "unobserved" as const, attacks: 0, observation: "Fireball disappeared before defense began." };
  const incoming = target.velocity.clone();
  let lastPosition = target.position.clone();
  let staleTicks = 0;
  let attacks = 0;
  bot.clearControlStates();
  bot.deactivateItem();
  while (target.isValid && bot.health > 0) {
    signal.throwIfAborted();
    if (target.velocity.dot(incoming) < 0) {
      return {
        kind: "reflected" as const,
        attacks,
        observation: "Observed the fireball reverse its incoming direction.",
      };
    }
    const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
    const toward = eye.minus(target.position);
    if (target.velocity.dot(toward) <= 0) break;
    // The server sends projectile movement less often than physics ticks. The
    // first fixture received x=4.17 and then the explosion, skipping reach.
    // Include the next server tick, when it can process this swing. Extrapolation
    // schedules a swing only; server velocity reversal is the verdict.
    staleTicks = lastPosition.equals(target.position) ? staleTicks + 1 : 0;
    lastPosition = target.position.clone();
    const estimated = projectedPosition(target, staleTicks + 1);
    await bot.lookAt(eye.minus(incoming), true);
    signal.throwIfAborted();
    const halfWidth = target.width / 2;
    const dx = Math.max(0, Math.abs(eye.x - estimated.x) - halfWidth);
    const dy = Math.max(estimated.y - eye.y, eye.y - estimated.y - target.height, 0);
    const dz = Math.max(0, Math.abs(eye.z - estimated.z) - halfWidth);
    if (Math.hypot(dx, dy, dz) <= ATTACK_REACH) {
      bot.attack(target);
      attacks += 1;
    }
    await bot.waitForTicks(1);
  }
  return {
    kind: "unobserved" as const,
    attacks,
    observation: "Fireball disappeared or passed without an observed reversal.",
  };
}
