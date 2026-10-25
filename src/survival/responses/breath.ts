import type { Bot } from "mineflayer";
import {
  createMovements,
  headOutOfLiquidGoal,
  horizontalControlsToward,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { airSupplyTicks } from "../../world/air-supply.js";
import { airSupplyPoints, FULL_AIR_POINTS, isInWater } from "../perception/body.js";
import { survivableSubmergedTicks } from "../policy/environment.js";
import { risingReachesAir } from "../positioning/swim-escape.js";
import type { Budgets } from "../state/budgets.js";

/**
 * How far a route to air looks, and for how long. Every tick searching is a
 * tick of air, so the search is short; sixteen blocks holds any route the air
 * and health could pay for at fourteen ticks a block.
 */
export const ESCAPE_SEARCH = Object.freeze({ primaryTimeoutMs: 250, failureTimeoutMs: 500, maximumRadius: 16 });

const HORIZONTAL = ["forward", "back", "left", "right"] as const;

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
  navigation: Pick<NavigationRuntime, "navigate">,
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
  const routes: { readonly budgetTicks: number; readonly result: NavigationResult }[] = [];
  signal.throwIfAborted();
  bot.on("physicsTick", tick);
  try {
    while (!budget.exhausted) {
      signal.throwIfAborted();
      const air = airSupplyPoints(bot);
      // Respawn can replace the body's metadata. Unknown air cannot retain
      // ownership on the strength of an old oxygenLevel value.
      if (air === null || air >= FULL_AIR_POINTS || bot.health <= 0) break;
      const column = isInWater(bot) ? risingReachesAir(bot) : null;
      if (column || !isInWater(bot)) {
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
          submergedTravel: { origin: bot.entity.position.clone(), airTicks: budgetTicks },
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
      routes.push({ budgetTicks, result });
      if (result.status !== "completed") break;
    }
  } finally {
    bot.off("physicsTick", tick);
    release(bot);
  }
  const airAfter = airSupplyPoints(bot);
  const route = routes.at(-1)?.result;
  return {
    kind:
      bot.health <= 0
        ? ("bot_died" as const)
        : airAfter === null
          ? ("air_unknown" as const)
          : airAfter >= FULL_AIR_POINTS
            ? ("air_full" as const)
            : ("stuck" as const),
    routes: routes.map(({ budgetTicks, result }) => ({
      budgetTicks,
      status: result.status,
      ...(result.status === "stopped" && { reason: result.reason }),
    })),
    ...(route?.status === "stopped" && { routeStopped: route.reason }),
    airAfter,
  };
}
