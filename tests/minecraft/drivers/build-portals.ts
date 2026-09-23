import { z } from "zod";
import type { ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  frames: z.array(z.strictObject({
    label: z.string(),
    x: z.number().int(), y: z.number().int(), z: z.number().int(),
    axis: z.enum(["x", "z"]),
  })).min(1),
});

/** All builds must succeed; Mine Labs independently checks each finished frame. */
export const run: ScenarioRun = async (context) => {
  const { frames } = paramsSchema.parse(context.scenario.params);
  const completed: string[] = [];
  for (const { label, ...frame } of frames) {
    const output = await context.call("build_structure", {
      portal_frame: frame, remove_wrong_blocks: true,
    });
    completed.push(`${label}: ${output.summary}`);
    if (output.result.status !== "succeeded") {
      return { status: "failed", detail: completed.join("; ") };
    }
  }
  return { status: "succeeded", detail: completed.join("; ") };
};
