import assert from "node:assert/strict";
import { z } from "zod";
import { containerContentSchema, useContainerResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

const paramsSchema = z.strictObject({
  steps: z.array(z.strictObject({ label: z.string(), action: z.string(), input: z.record(z.string(), z.unknown()) })).min(1),
  protected_container: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  expected_contents: z.array(containerContentSchema),
});

/** Mine Labs checks surviving blocks; this driver also opens storage to verify its actual contents. */
export const run: ScenarioRun = async (context) => {
  const { steps, protected_container, expected_contents } = paramsSchema.parse(context.scenario.params);
  const completed: string[] = [];
  for (const { label, action, input } of steps) {
    const output = await context.call(action, input);
    completed.push(`${label}: ${output.summary}`);
    if (output.result.status !== "succeeded") return { status: "failed", detail: completed.join("; ") };
  }

  const output = await context.call("use_container", { operation: "inspect", ...protected_container });
  const result = useContainerResultSchema.parse(output.result);
  if (result.status !== "succeeded") return { status: "failed", detail: output.summary };
  assert.deepEqual(result.container.contents, expected_contents, "The protected chest must retain every original item and slot.");
  return { status: "succeeded", detail: `${completed.join("; ")}; protected chest contents unchanged.` };
};
