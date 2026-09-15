import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { DEFAULT_NAVIGATION_POLICY } from "../../../src/survival/policy/contract.ts";
/**
 * Corridor fixtures for the hostile avoidance field.
 *
 * Two ways past a wall: a short corridor with a zombie standing in it, and a
 * longer detour outside the zombie's reach. The goal is arrival; lane choice,
 * excavation, and search work are comparative diagnostics. The field is
 * registered here rather than by the session because these scenarios drive
 * navigation directly and never attach the contact reflex - which is also what
 * makes them deterministic: nothing fights, so what is measured is the route.
 *
 * `field: false` runs the same world with no field registered, which is the
 * control and the second half of the search-work measurement.
 */
import {
  ActionRunner,
  createHostileStepFieldProvider,
  createNavigateAction,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  target: z.tuple([z.number(), z.number(), z.number()]),
  range: z.number().optional().default(1.5),
  /** Whether the hostile step field is registered; false is the control run. */
  field: z.boolean().optional().default(true),
  corridorX: z.number(),
  detourX: z.number(),
  /** The z range, inclusive, over which the two lanes are separated by wall. */
  laneZ: z.tuple([z.number(), z.number()]),
});

/** Nothing has been killed, provoked, found unreachable, or hidden from: a zombie is a threat on sight. */
const NO_ENCOUNTER = {
  resolvedIds: new Set<number>(),
  attackerIds: new Set<number>(),
  unreachableIds: new Set<number>(),
};

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const [laneFrom, laneTo] = params.laneZ;
  const minZ = Math.min(laneFrom, laneTo);
  const maxZ = Math.max(laneFrom, laneTo);

  // The last slice of each search carries that search's running totals, so
  // keeping one entry per search and summing at the end gives nodes expanded
  // and compute time over the whole route.
  const searchTotals = new Map<string, { visited: number; computeMs: number }>();
  const stopObserving = context.navigation.onEvent((event) => {
    if (event.kind === "search_slice") {
      searchTotals.set(event.searchId, { visited: event.visited, computeMs: event.computeMs });
    }
  });

  const walked = { corridor: false, detour: false };
  const sample = () => {
    const { x, z } = bot.entity.position;
    const cellX = Math.floor(x);
    const cellZ = Math.floor(z);
    if (cellZ < minZ || cellZ > maxZ) return;
    if (cellX === params.corridorX) walked.corridor = true;
    if (cellX === params.detourX) walked.detour = true;
  };
  bot.on("physicsTick", sample);

  try {
    await bot.waitForChunksToLoad();
    if (params.field) {
      context.navigation.setStepFieldProvider(
        createHostileStepFieldProvider(
          bot, { ...NO_ENCOUNTER, policy: DEFAULT_COMBAT_POLICY }, () => null, () => DEFAULT_NAVIGATION_POLICY,
        ),
      );
    }

    const [x, y, z] = params.target;
    const runner = new ActionRunner();
    const navigate = createNavigateAction(bot, context.navigation);
    const startedAt = Date.now();
    const output = await runner.run(navigate, { x, y, z, range: params.range }, context.signal);
    const elapsedMs = Date.now() - startedAt;

    let visited = 0;
    let computeMs = 0;
    for (const total of searchTotals.values()) {
      visited += total.visited;
      computeMs += total.computeMs;
    }
    const took = walked.detour ? "detour" : walked.corridor ? "corridor" : "neither lane";
    const work =
      `field ${params.field ? "on" : "off"}; took the ${took}; ` +
      `${visited} nodes expanded over ${computeMs.toFixed(0)} ms of search in ${searchTotals.size} searches; ` +
      `route settled in ${elapsedMs} ms`;
    context.log(work);

    if (output.result.status !== "succeeded") {
      return {
        status: "failed",
        detail: `navigate ${output.result.status}: ${output.result.error ?? "no error"}; ${work}`,
      };
    }
    return { status: "succeeded", detail: work };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    context.log(`hostile corridor exception: ${message}`);
    return { status: "failed", detail: message };
  } finally {
    bot.off("physicsTick", sample);
    stopObserving();
  }
}
