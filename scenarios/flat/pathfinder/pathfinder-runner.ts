/** Generic scenario driver for pathfinder navigation tests with candidate comparison telemetry. */
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import {
  createMovements,
  ActionRunner,
  createNavigateAction,
} from "@aibengineering/mine-ai-mcp";
import type { NavigationEvent } from "../../../src/navigation/telemetry/index.ts";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const navLegSchema = z.strictObject({
  target: z.tuple([z.number(), z.number(), z.number()]),
  range: z.number().optional().default(1.5),
  label: z.string().optional(),
});

const paramsSchema = z.strictObject({
  target: z.tuple([z.number(), z.number(), z.number()]).optional(),
  range: z.number().optional().default(1.5),
  legs: z.array(navLegSchema).optional(),
  allowDoors: z.boolean().optional(),
  allowDiagonalAscend: z.boolean().optional(),
});

export type PathfinderRunnerParams = z.infer<typeof paramsSchema>;

export async function run(
  context: MineAiScenarioContext,
  observation?: Readonly<{ onCandidateEvent?: (event: NavigationEvent) => void }>,
): Promise<ClientCompletion> {
  const { bot } = context;
  // Scenarios that assert on how the route was executed, not just where it
  // ended, watch the live event stream through this. Accepting the callback
  // without subscribing made those assertions unobservable, so they failed on
  // routes that had in fact done exactly what they asked for.
  const stopObserving = observation?.onCandidateEvent
    ? context.pathfinder.onEvent(observation.onCandidateEvent)
    : undefined;
  try {
    await bot.waitForChunksToLoad();

    const params = paramsSchema.parse(context.scenario.params ?? {});

    const legs: Array<{ target: [number, number, number]; range: number; label?: string }> =
      params.legs && params.legs.length > 0
        ? params.legs
        : params.target
          ? [{ target: params.target, range: params.range, label: "target" }]
          : [];

    if (legs.length === 0) {
      throw new Error("No navigation target or legs specified in scenario params.");
    }

    const runner = new ActionRunner();
    const navigate = createNavigateAction(bot, context.navigation, {
      createMovements: (movementBot) =>
        createMovements(movementBot, {
          ...(params.allowDoors !== undefined ? { allowDoors: params.allowDoors } : {}),
          ...(params.allowDiagonalAscend !== undefined ? { allowDiagonalAscend: params.allowDiagonalAscend } : {}),
        }),
      navigate: context.navigation.navigate,
    });
    const legResults: string[] = [];

    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      const [tx, ty, tz] = leg.target;
      const label = leg.label ?? `leg ${index + 1}`;
      context.log(`Starting ${label} to [${tx}, ${ty}, ${tz}] with range ${leg.range}`);

      const startedAt = Date.now();
      const output = await runner.run(navigate, { x: tx, y: ty, z: tz, range: leg.range }, context.signal);

      const result = output.result;
      const elapsedMs = Date.now() - startedAt;

      if (result.status !== "succeeded") {
        const errorDetail = `${label} failed with status ${result.status}: ${result.error ?? "unknown error"}`;
        context.log(errorDetail);
        return {
          status: "failed",
          detail: `${errorDetail}; ${legResults.join("; ")}; ${context.pathfinder.summary()}`,
        };
      }

      const botPos = bot.entity.position;
      const remainingDistance = new Vec3(tx, ty, tz).distanceTo(botPos);
      const legDetail = `${label} succeeded in ${elapsedMs} ms (remaining: ${remainingDistance.toFixed(2)}, at ${botPos.floored().toString()})`;
      context.log(legDetail);
      legResults.push(legDetail);
    }

    const finalDetail = `All legs succeeded: ${legResults.join("; ")}; ${context.pathfinder.summary()}`;
    return { status: "succeeded", detail: finalDetail };
  } catch (cause) {
    const errorMsg = cause instanceof Error ? cause.message : String(cause);
    const detail = `${errorMsg}; ${context.pathfinder.summary()}`;
    context.log(`Scenario exception: ${detail}`);
    return { status: "failed", detail };
  } finally {
    stopObserving?.();
  }
}
