import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  createMovements,
  headOutOfLiquidGoal,
  horizontalControlsToward,
  risingSurface,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { airSupplyTicks } from "../../world/air-supply.js";
import { airSupplyPoints, FULL_AIR_POINTS, isInWater } from "../perception/body.js";
import { survivableSubmergedTicks } from "../policy/environment.js";
import type { Budgets } from "../state/budgets.js";

/**
 * How far a route to air looks, and for how long. Every tick searching is a
 * tick of air, so the search is short; sixteen blocks holds any route the air
 * and health could pay for at fourteen ticks a block.
 */
export const ESCAPE_SEARCH = Object.freeze({ primaryTimeoutMs: 250, failureTimeoutMs: 500, maximumRadius: 16 });

const HORIZONTAL = ["forward", "back", "left", "right"] as const;

/**
 * One route asked for: the ticks it could spend under water, and how it
 * ended. A type, not an interface, so it is reportable `Facts`.
 */
export type AirRoute = {
  readonly budgetTicks: number;
  readonly status: "completed" | "stopped";
  readonly reason?: string;
};

function release(bot: Bot): void {
  bot.setControlState("jump", false);
  for (const control of HORIZONTAL) bot.setControlState(control, false);
}

/**
 * Get the head into air and keep it there until the bar is full. Straight up
 * when the column overhead leads to air; otherwise navigation routes to the
 * nearest air, through water under a roof within what the air and health can
 * pay for, digging only what the carried tools can harvest. With no route the
 * body goes back to its owner at once rather than held until it drowns.
 */
export async function surface(
  bot: Bot,
  navigation: Pick<NavigationRuntime, "navigate" | "world">,
  signal: AbortSignal,
  budgets: Budgets,
  maximumTicks: number,
) {
  let ticks = 0;
  const tick = () => {
    ticks++;
  };
  using budget = budgets.attempt({
    name: "surface.rise",
    scope: "surface",
    unit: "ticks",
    limit: maximumTicks,
    measure: () => ticks,
    exhaustion: "stuck",
  });
  const routes: AirRoute[] = [];
  const read = (x: number, y: number, z: number) => navigation.world.blockAt(x, y, z);
  signal.throwIfAborted();
  bot.on("physicsTick", tick);
  try {
    while (!budget.exhausted) {
      signal.throwIfAborted();
      const air = airSupplyPoints(bot);
      // Respawn can replace the body's metadata. Unknown air cannot retain
      // ownership on the strength of an old oxygenLevel value.
      if (air === null || air >= FULL_AIR_POINTS || bot.health <= 0) break;
      const inWater = isInWater(bot);
      const feet = bot.entity.position.floored();
      // Rising alone reaches air: centre on the cell, which clears a shoulder
      // caught under an overhang beside the column (OffsetDiver's deepslate,
      // LowAirDiver's bedrock), and hold jump.
      const column = inWater && risingSurface(read, feet)
        ? new Vec3(feet.x + 0.5, bot.entity.position.y, feet.z + 0.5)
        : null;
      // Rise up the open column, or wait out of the water while the bar refills.
      if (column || !inWater) {
        const horizontal = column ? horizontalControlsToward(bot.entity, column, 0.05) : null;
        for (const control of HORIZONTAL) bot.setControlState(control, horizontal?.[control] ?? false);
        bot.setControlState("jump", column !== null);
        await waitForPhysicsTicks(bot, 1, signal);
        continue;
      }
      // Navigation takes the controls from here.
      release(bot);
      const budgetTicks = survivableSubmergedTicks(airSupplyTicks(bot) ?? 0, bot.health);
      const result = await navigation.navigate({
        movements: createMovements(bot, {
          dive: { origin: bot.entity.position.clone(), airTicks: budgetTicks, ascent: "goal" },
          // A hand-dug obsidian ceiling never opens; stone by hand under
          // water takes over half a minute. Price breaks by their time alone,
          // which under water is the air they spend.
          requireHarvestTool: true,
          breakPenalty: 0,
          scaffolding: false,
          allowParkour: false,
        }),
        goal: headOutOfLiquidGoal(),
        signal,
        timeoutMs: Math.max(1, (maximumTicks - ticks) * 50),
        searchLimits: ESCAPE_SEARCH,
      });
      routes.push({ budgetTicks, status: result.status, ...(result.status === "stopped" && { reason: result.reason }) });
      if (result.status !== "completed") break;
    }
  } finally {
    bot.off("physicsTick", tick);
    release(bot);
  }
  const airAfter = airSupplyPoints(bot);
  return {
    kind:
      bot.health <= 0
        ? ("bot_died" as const)
        : airAfter === null
          ? ("air_unknown" as const)
          : airAfter >= FULL_AIR_POINTS
            ? ("air_full" as const)
            : ("stuck" as const),
    routes,
    airAfter,
  };
}
