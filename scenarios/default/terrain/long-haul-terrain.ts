/**
 * Walk a long route across generated terrain.
 *
 * On a default world the destination's height is whatever the generator
 * decided, and the column is not loaded when the run starts, so the driver
 * walks toward it in stages and resolves the surface only once the chunk is
 * actually in hand. That staging is deliberate: it is the same shape as
 * `explore-frontier`, which advances a frontier it cannot see the far side of.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { createMovements, nearXzGoal } from "../../../src/navigation/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  eastward: z.number(),
  northward: z.number(),
  range: z.number(),
});

/** How far each leg reaches toward the destination column. */
const LEG_BLOCKS = 40;
/**
 * Legs aim at a column, not at a point.
 *
 * Resolving the destination's height by scanning blocks was the wrong model.
 * Terrain height is the generator's business and a leg that names it is
 * asserting something the driver cannot know: at 137,-70 the surface sits at
 * y 48 while its neighbours are near y 77, so a leg aimed there asked for a
 * 29-block descent against a `maximumDrop` of 3. Neither pathfinder does that
 * — the candidate gives up and reports, and baseline simply never finishes —
 * so the fixture was failing both of them for its own reasons.
 *
 * `GoalNearXZ` states what the leg actually wants, which is horizontal
 * progress, and leaves the height to whoever is doing the walking.
 */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const movements = createMovements(bot);

  const start = bot.entity.position.clone();
  const targetX = Math.round(start.x + params.eastward);
  const targetZ = Math.round(start.z - params.northward);
  const totalDistance = Math.hypot(targetX - start.x, targetZ - start.z);
  const legs = Math.max(1, Math.ceil(totalDistance / LEG_BLOCKS));
  const reports: string[] = [];

  for (let leg = 1; leg <= legs; leg += 1) {
    const fraction = leg / legs;
    const x = Math.round(start.x + (targetX - start.x) * fraction);
    const z = Math.round(start.z + (targetZ - start.z) * fraction);
    const range = leg === legs ? params.range : 4.0;
    const route = await context.navigation.navigate({
      movements,
      goal: nearXzGoal({ x, z }, range),
      signal: context.signal,
    });
    reports.push(`leg ${leg}/${legs} -> ${x},${z} r${range}: ${route.status}`);
    context.log(reports.at(-1)!);
    if (route.status !== "completed") break;
  }

  const finish = bot.entity.position;
  const remaining = Math.hypot(targetX - finish.x, targetZ - finish.z);
  const detail =
    `travelled ${Math.hypot(finish.x - start.x, finish.z - start.z).toFixed(1)} blocks, ` +
    `${remaining.toFixed(1)} short of the destination column at y ${finish.y.toFixed(1)}; ` +
    `${reports.join("; ")}; ${context.pathfinder.summary()}`;
  return remaining <= params.range + 1 ? { status: "succeeded", detail } : { status: "failed", detail };
}
