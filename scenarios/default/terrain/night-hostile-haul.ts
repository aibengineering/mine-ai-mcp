/**
 * Walk a long route across generated terrain at night, with mobs spawning and
 * the production runtime attached.
 *
 * The corridor fixtures prove the hostile avoidance field prefers the far side
 * of a hand-built wall. They cannot say whether it breaks a real route, and
 * that is the question this asks: a hundred and twenty blocks of terrain the
 * planner has not seen, in the dark, with the field pricing whatever the
 * generator spawned along the way.
 *
 * The runtime is the production one, opened the way the live host opens it, so
 * the contact reflex is attached and the field is registered by the session
 * rather than by this driver. `field: false` runs the same world with the
 * provider configured to supply nothing for the control run.
 *
 * The driver submits one request. The production session owns its continuation.
 */
import { NAVIGATE, navigateResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /** Destination offsets from wherever the server actually spawned the bot. */
  eastward: z.number(),
  northward: z.number(),
  /** Surveyed feet height when the destination column also contains cave floors. */
  destinationHeight: z.number().int().optional(),
  range: z.number().default(3),
  /** False starts the session without a hostile field. */
  field: z.boolean().default(true),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  await bot.waitForChunksToLoad();

  const runtime = await openRuntime(
    context,
    "night-hostile-haul",
    params.field ? {} : { stepFieldProvider: () => null },
  );
  try {
    await wearArmor(context);

    // The last slice of each search carries that search's running totals, so
    // one entry per search summed at the end is the work the whole haul cost.
    // It includes the reflex's own approach and evade routes, which is stated
    // rather than filtered: they are part of what a night crossing costs.
    const searchTotals = new Map<string, { visited: number; computeMs: number }>();
    const runs = new Set<string>();
    const stopObserving = runtime.navigation.onEvent((event) => {
      if (event.kind !== "search_slice") return;
      searchTotals.set(event.searchId, { visited: event.visited, computeMs: event.computeMs });
      runs.add(event.runId);
    });

    const navigateAction = runtime.actions.find((action) => action.name === NAVIGATE);
    if (!navigateAction) throw new Error("The night haul could not find its production navigate action.");

    const start = bot.entity.position.clone();
    const target = {
      x: Math.round(start.x + params.eastward),
      z: Math.round(start.z - params.northward),
    };
    const distance = Math.hypot(target.x - start.x, target.z - start.z);
    // The caller can name a surveyed surface; otherwise the action may resolve
    // only an unambiguous column. Floor selection remains outside navigation.
    const request = { x: target.x, y: params.destinationHeight, z: target.z, range: params.range };

    const startedAt = Date.now();
    let output: Awaited<ReturnType<typeof runtime.run>>;
    try {
      output = await runtime.run(navigateAction, request, context.signal);
    } finally {
      stopObserving();
    }
    const interruptions = output.interruptions ?? [];
    const result = navigateResultSchema.safeParse(output.result);
    const elapsedMs = Date.now() - startedAt;

    let visited = 0;
    let computeMs = 0;
    for (const total of searchTotals.values()) {
      visited += total.visited;
      computeMs += total.computeMs;
    }
    const finish = bot.entity.position;
    const remaining = Math.hypot(target.x - finish.x, target.z - finish.z);
    const arrived = remaining <= params.range && bot.health > 0;
    const detail =
      `field ${params.field ? "on" : "off"}; ${arrived ? "arrived" : "did not arrive"} ` +
      `${remaining.toFixed(1)} from the destination column after ${distance.toFixed(0)} blocks; ` +
      `action ${result.success ? result.data.status : "returned an invalid result"}; ` +
      `one navigate call, ${interruptions.length} interruptions, ` +
      `${runs.size} navigation runs; ${visited} nodes expanded over ${computeMs.toFixed(0)} ms of search ` +
      `in ${searchTotals.size} searches; route time ${elapsedMs} ms; health ${bot.health}`;
    context.log(detail);
    return arrived ? { status: "succeeded", detail } : { status: "failed", detail };
  } finally {
    await runtime.close();
  }
}
