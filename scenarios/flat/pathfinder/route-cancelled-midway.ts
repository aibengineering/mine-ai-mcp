/**
 * Cancel a sprinting route mid-flight, then navigate again on the same
 * pathfinder.
 *
 * The route is driven through production `navigate()` so the cancellation path
 * under test is the one every action actually uses, `stopSignal` included.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { createMovements, nearGoal } from "../../../src/navigation/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  firstTarget: z.tuple([z.number(), z.number(), z.number()]),
  cancelAfterMs: z.number(),
  stopBefore: z.number(),
  secondTarget: z.tuple([z.number(), z.number(), z.number()]),
});

/** How long a cancelled bot is given to bleed off its speed. */
const SETTLE_TICKS = 20;
/** Blocks per tick below which the bot counts as stopped rather than coasting. */
const RESTING_SPEED = 0.02;

function speed(context: MineAiScenarioContext): number {
  const velocity = context.bot.entity.velocity;
  return Math.hypot(velocity.x, velocity.z);
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const movements = createMovements(bot);

  const [fx, fy, fz] = params.firstTarget;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort("scenario_cancelled"), params.cancelAfterMs);
  const cancelled = await context.navigation
    .navigate({
      movements,
      goal: nearGoal({ x: fx, y: fy, z: fz }, 1.5),
      stopSignal: stop.signal,
      signal: context.signal,
    })
    .finally(() => clearTimeout(timer));

  if (cancelled.status !== "stopped") {
    return {
      status: "failed",
      detail: `The cancelled route reported ${cancelled.status}, not stopped. ${context.pathfinder.summary()}`,
    };
  }

  // Where it was told to stop, versus where it actually came to rest. The
  // difference is exactly the coast a released control leaves behind.
  const atSignal = bot.entity.position.x;
  await bot.waitForTicks(SETTLE_TICKS);
  const atRest = bot.entity.position.x;
  const coasted = atRest - atSignal;
  const restingSpeed = speed(context);
  const stopDetail =
    `stopped at x ${atSignal.toFixed(2)}, rest at x ${atRest.toFixed(2)} ` +
    `(coasted ${coasted.toFixed(2)}, speed ${restingSpeed.toFixed(3)})`;

  if (atRest >= params.stopBefore) {
    return {
      status: "failed",
      detail: `The bot ran past its cancellation: ${stopDetail}, required x < ${params.stopBefore}. ${context.pathfinder.summary()}`,
    };
  }
  if (restingSpeed > RESTING_SPEED) {
    return {
      status: "failed",
      detail: `The bot still held movement controls after cancelling: ${stopDetail}. ${context.pathfinder.summary()}`,
    };
  }

  // The real production risk: a pathfinder left dirty by cancellation
  // refuses or corrupts every route after it.
  const [sx, sy, sz] = params.secondTarget;
  const resumed = await context.navigation.navigate({
    movements,
    goal: nearGoal({ x: sx, y: sy, z: sz }, 1.5),
    signal: context.signal,
  });
  const detail = `${stopDetail}; second route ${resumed.status}; ${context.pathfinder.summary()}`;
  return resumed.status === "completed"
    ? { status: "succeeded", detail }
    : { status: "failed", detail: `The pathfinder did not recover from cancellation: ${detail}` };
}
