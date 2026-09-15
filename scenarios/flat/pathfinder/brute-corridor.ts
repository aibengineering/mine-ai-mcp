import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { DEFAULT_NAVIGATION_POLICY } from "../../../src/survival/policy/contract.ts";
/**
 * Corridor fixtures for hostiles that win the fight on arrival.
 *
 * `hostile-corridor.ts` beside this one asks whether the route goes round a
 * mob. That is not the question a brute poses. A brute picks the bot up at
 * sixteen blocks and cannot be pacified, outranges the spacing melee relies
 * on, and hits for thirteen; by the time the route is "past" it the fight has
 * already started. So what is measured here is not which opening was used but
 * how close the route ever came, and the fixture fails on a pass that would
 * have handed the brute the decision even though the bot arrived.
 *
 * Three ways through the wall, and the middle one is the point: it is wider
 * than the old twelve-block radius, so a field that stopped pricing at twelve
 * called it free and took it - straight through acquisition range for nothing.
 * Passing this means the route paid to stay outside sixteen instead.
 *
 * The hostiles are NoAI. Nothing chases and nothing swings, so what is
 * measured is the route rather than a fight, and a trial reads the same
 * however long it takes. That also means arrival alone proves very little
 * here, which is why closest approach is the assertion.
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
  /** The species the fixture stands in the corridor, and the one approach is judged against. */
  species: z.string(),
  /**
   * How close the route may come before the mob would have chosen the fight.
   * Vanilla follow range for the species the fixture places.
   */
  acquisitionRange: z.number(),
  /** Lane openings in the wall, by name, as the x of the air column. */
  lanes: z.array(z.tuple([z.string(), z.number()])),
  /** The z range, inclusive, over which the lanes are separated by wall. */
  laneZ: z.tuple([z.number(), z.number()]),
});

/** Nothing killed, provoked, found unreachable, or hidden from: a brute is a threat on sight. */
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

  const searchTotals = new Map<string, { visited: number; computeMs: number }>();
  const stopObserving = context.navigation.onEvent((event) => {
    if (event.kind === "search_slice") {
      searchTotals.set(event.searchId, { visited: event.visited, computeMs: event.computeMs });
    }
  });

  const walked = new Set<string>();
  // Closest approach to any of them, over the whole route rather than at the
  // end: a route that brushed one and withdrew still started that fight.
  let closest = Number.POSITIVE_INFINITY;
  const sample = () => {
    const position = bot.entity.position;
    for (const id in bot.entities) {
      const entity = bot.entities[id];
      if (entity?.name !== params.species || !entity.isValid) continue;
      closest = Math.min(closest, position.distanceTo(entity.position));
    }
    const cellX = Math.floor(position.x);
    const cellZ = Math.floor(position.z);
    if (cellZ < minZ || cellZ > maxZ) return;
    for (const [name, x] of params.lanes) if (cellX === x) walked.add(name);
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
    const lanes = walked.size > 0 ? [...walked].join("+") : "no lane";
    const approach = Number.isFinite(closest) ? closest.toFixed(1) : "never loaded";
    const work =
      `field ${params.field ? "on" : "off"}; took ${lanes}; ` +
      `closest approach ${approach} of ${params.acquisitionRange} acquisition; ` +
      `${visited} nodes expanded over ${computeMs.toFixed(0)} ms of search in ${searchTotals.size} searches; ` +
      `route settled in ${elapsedMs} ms`;
    context.log(work);

    if (output.result.status !== "succeeded") {
      return {
        status: "failed",
        detail: `navigate ${output.result.status}: ${output.result.error ?? "no error"}; ${work}`,
      };
    }
    // Arrival is not the result. A route that reached the target through
    // acquisition range only survived because the fixture pinned the mob.
    if (!Number.isFinite(closest)) {
      return { status: "failed", detail: `no ${params.species} was ever loaded, so approach proves nothing; ${work}` };
    }
    if (closest < params.acquisitionRange) {
      return { status: "failed", detail: `entered ${params.species} acquisition range; ${work}` };
    }
    return { status: "succeeded", detail: work };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    context.log(`brute corridor exception: ${message}`);
    return { status: "failed", detail: message };
  } finally {
    bot.off("physicsTick", sample);
    stopObserving();
  }
}
