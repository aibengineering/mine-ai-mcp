/**
 * Prove that a tower the pathfinder builds is a tower it can climb back down.
 *
 * On 1 September 2026 the live bot navigated to y 99 from ground at y 69,
 * because the model took the base's altitude for "the surface", and pillared
 * thirty blocks into open air. It was then stranded on the top block after the
 * operator dug the pillar out from under it. navigate now refuses a
 * target with no standable cell, which is the change that prevents the ascent.
 *
 * These fixtures ask for the same thing on purpose - a mid-air goal thirty
 * blocks up, through the runtime directly since the action refuses it - and
 * then ask for the ground again. Straight up, eight columns diagonal, and
 * straight up from under a birch canopy all build one solid pillar in the goal
 * column and reverse it with the downward dig. The detail names what was built
 * and what the descent said, so a failure would be legible.
 */
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createMovements } from "@aibengineering/mine-ai-mcp";
import { nearGoal } from "../../../src/navigation/index.ts";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /** The mid-air goal: `height` blocks above the ground, `offset` columns away from the start. */
  height: z.number().int().positive(),
  offset: z.tuple([z.number().int(), z.number().int()]).default([0, 0]),
  range: z.number().nonnegative().default(1.5),
});

/** Every scaffold block within a few columns of the tower, and whether the bot's own column is solid beneath it. */
function describeTower(context: MineAiScenarioContext, ground: number): string {
  const { bot } = context;
  const feet = bot.entity.position.floored();
  let placed = 0;
  let inOwnColumn = 0;
  for (let x = feet.x - 3; x <= feet.x + 3; x += 1) {
    for (let z = feet.z - 3; z <= feet.z + 3; z += 1) {
      for (let y = ground; y < feet.y; y += 1) {
        if (bot.blockAt(new Vec3(x, y, z))?.name !== "dirt") continue;
        placed += 1;
        if (x === feet.x && z === feet.z) inOwnColumn += 1;
      }
    }
  }
  let gap = 0;
  for (let y = feet.y - 1; y >= ground; y -= 1) {
    if (bot.blockAt(new Vec3(feet.x, y, feet.z))?.boundingBox === "block") break;
    gap += 1;
  }
  return `standing at ${feet.x},${feet.y},${feet.z}; ${placed} dirt placed within 3 columns, ${inOwnColumn} in the bot's own column, ${gap} blocks of air directly beneath`;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();
    const params = paramsSchema.parse(context.scenario.params ?? {});
    const start = bot.entity.position.floored();
    const top = { x: start.x + params.offset[0], y: start.y + params.height, z: start.z + params.offset[1] };

    const up = await context.navigation.navigate({
      movements: createMovements(bot),
      goal: nearGoal(top, params.range),
      signal: context.signal,
    });
    const tower = describeTower(context, start.y);
    context.log(`ascent ${up.status}: ${tower}`);
    if (up.status !== "completed") {
      return { status: "failed", detail: `The pathfinder did not reach the mid-air goal: ${up.reason}; ${tower}` };
    }

    const down = await context.navigation.navigate({
      movements: createMovements(bot),
      goal: nearGoal(start, params.range),
      signal: context.signal,
    });
    const back = bot.entity.position.floored();
    const detail = `ascent completed (${tower}); descent ${down.status}${down.status === "stopped" ? `: ${down.reason}` : ""}; now at ${back.x},${back.y},${back.z}; ${context.pathfinder.summary()}`;
    context.log(detail);
    return down.status === "completed" && back.y <= start.y + 1
      ? { status: "succeeded", detail }
      : { status: "failed", detail };
  } catch (cause) {
    return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
