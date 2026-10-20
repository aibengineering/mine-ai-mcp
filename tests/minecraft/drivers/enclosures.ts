import assert from "node:assert/strict";
import { z } from "zod";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioRun } from "../scenario.ts";

const cellSchema = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
/**
 * A region of one block: `fill` is every cell, `walls` only its vertical sides,
 * `shell` its whole surface. The YAML stays readable; the request lists cells.
 */
const regionSchema = z.strictObject({
  shape: z.enum(["fill", "walls", "shell"]),
  from: cellSchema,
  to: cellSchema,
});
const penSchema = z.strictObject({
  waitTicks: ticksSchema.optional(),
  block_name: z.string().min(1),
  regions: z.array(regionSchema).min(1),
  remove_wrong_blocks: z.boolean().optional(),
  /** The finished build must not contain the builder: its interior, which the bot must have left. */
  endOutside: z.strictObject({ from: cellSchema, to: cellSchema }).optional(),
});

function cells(region: z.output<typeof regionSchema>, block_name: string) {
  const range = (axis: 0 | 1 | 2) => [Math.min(region.from[axis], region.to[axis]), Math.max(region.from[axis], region.to[axis])] as const;
  const [[x0, x1], [y0, y1], [z0, z1]] = [range(0), range(1), range(2)];
  const out: { x: number; y: number; z: number; block_name: string }[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const side = x === x0 || x === x1 || z === z0 || z === z1;
        const surface = side || y === y0 || y === y1;
        if (region.shape === "fill" || (region.shape === "walls" && side) || (region.shape === "shell" && surface))
          out.push({ x, y, z, block_name });
      }
  return out;
}

/** One build_structure request per pen; where the builder ends up is part of the outcome. */
export const run: ScenarioRun = async (context) => {
  const pen = playerParams(context, penSchema);
  if (pen.waitTicks !== undefined) await context.waitForTicks(pen.waitTicks);
  const blocks = pen.regions.flatMap((region) => cells(region, pen.block_name));
  const output = await context.call("build_structure", {
    blocks,
    ...(pen.remove_wrong_blocks !== undefined && { remove_wrong_blocks: pen.remove_wrong_blocks }),
  });
  const { matches, detail } = checkExpectation({ status: ["succeeded"] }, output);
  if (!matches) return { status: "failed", detail };
  if (pen.endOutside) {
    const { situation } = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
    const feet = [situation.position.x, situation.position.y, situation.position.z].map(Math.floor);
    const inside = feet.every((value, axis) => {
      const [a, b] = [pen.endOutside!.from[axis]!, pen.endOutside!.to[axis]!];
      return value >= Math.min(a, b) && value <= Math.max(a, b);
    });
    assert.ok(!inside, `The builder ended inside its own enclosure at ${feet.join(",")}.`);
  }
  return { status: "succeeded", detail: `${blocks.length} cells; ${detail}` };
};
