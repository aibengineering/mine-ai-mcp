/**
 * How a Minecraft player decelerates once its input is released.
 *
 * A fact about the game, not about navigation: both the route executor's
 * movement controllers and direct local steering need it to know when to stop
 * asking for forward motion, so it lives beside the other world facts rather
 * than inside either owner.
 */
import type { Position3 } from "../utils/index.js";

/** Ticks of coasting a released input takes to bleed off. */
export const COAST_TICKS = 2;

/** Half the player's 0.6-block collision width: a cell centre closer than this is under the body, not ahead of it. */
export const PLAYER_HALF_WIDTH = 0.3;

/**
 * Ticks of horizontal travel left in an airborne body, per block per tick of
 * speed. Off the ground there is no block friction, only the 0.91 inertia
 * prismarine-physics applies each tick, so the remaining travel is
 * v × 0.91 / (1 − 0.91) ≈ 10 v: a body sliding down a vine at 0.08 a tick
 * drifted a whole cell sideways and out of the column on that alone.
 */
export const AIR_COAST_TICKS = 10;

/**
 * How far the bot travels after its inputs are released.
 *
 * This replaced a per-movement constant table — 1.4 for `sprint_jump`, 0.8 for
 * `parkour`, 0.5 for everything else — which was this function with the
 * velocity taken out and the answer guessed per movement kind. The guesses were
 * not bad, because a movement kind is a decent proxy for how fast it usually
 * goes, but a kind cannot know that this particular crossing was entered slowly
 * or that the run-up was cut short. Reassuringly, feeding typical speeds
 * through here reproduces the old table to within a few hundredths.
 */
export function stoppingDistance(velocity: Position3): number {
  return Math.hypot(velocity.x, velocity.z) * COAST_TICKS;
}
