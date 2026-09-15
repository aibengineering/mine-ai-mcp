/**
 * Build one structure with `build_structure` and report the audit,
 * plus where the bot ended up, which is the point of the sealed-box fixture.
 */
import {
  attachHighlighter,
  createBuildStructureAction,
  ActionRunner,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";

import type { MineAiScenarioContext } from "./scenario-client.ts";

const cellSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({
  /** A hollow box: its lowest corner, its size, and the block, expanded here so the fixture stays readable. */
  box: z.strictObject({ origin: cellSchema, size: z.number().int().min(3), block_name: z.string() }),
  /** The box must not contain the bot when the build finishes. */
  end_outside: z.boolean().default(true),
});

function boxShell(box: z.output<typeof paramsSchema>["box"]) {
  const cells: { x: number; y: number; z: number; block_name: string }[] = [];
  const last = box.size - 1;
  for (let dx = 0; dx <= last; dx += 1)
    for (let dy = 0; dy <= last; dy += 1)
      for (let dz = 0; dz <= last; dz += 1) {
        const onShell = dx === 0 || dy === 0 || dz === 0 || dx === last || dy === last || dz === last;
        if (onShell)
          cells.push({ x: box.origin.x + dx, y: box.origin.y + dy, z: box.origin.z + dz, block_name: box.block_name });
      }
  return cells;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const build = createBuildStructureAction(bot, context.navigation);
  const blocks = boxShell(params.box);
  context.log(`build_structure with ${blocks.length} cells`);

  const { result, durationMs } = await runner.run(build, { blocks }, context.signal);
  const error = "error" in result ? result.error : "";
  const audit = (result as { structure?: Record<string, unknown> }).structure;
  context.log(`${result.status} in ${durationMs} ms${error ? ` — ${error}` : ""}; audit ${JSON.stringify(audit)}`);

  const feet = bot.entity.position.floored();
  const last = params.box.size - 1;
  const inside =
    feet.x > params.box.origin.x &&
    feet.x < params.box.origin.x + last &&
    feet.z > params.box.origin.z &&
    feet.z < params.box.origin.z + last &&
    feet.y >= params.box.origin.y &&
    feet.y <= params.box.origin.y + last;
  const detail = `${result.status} in ${durationMs} ms; ended at ${feet.x},${feet.y},${feet.z}${inside ? " inside the box" : " outside the box"}; ${JSON.stringify(audit)}${error ? `; ${error}` : ""}`;
  if (result.status !== "succeeded") return { status: "failed", detail };
  if (params.end_outside && inside) return { status: "failed", detail };
  return { status: "succeeded", detail };
}
