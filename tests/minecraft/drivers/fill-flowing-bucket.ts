import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import type { ScenarioContext } from "../scenario.ts";

const cellSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ cell: cellSchema, refuse: cellSchema });

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { cell, refuse } = paramsSchema.parse(context.scenario.params);

  // Setup is frozen until the trial starts. Water needs 15 ticks to flow three cells.
  await context.waitForTicks(20);

  // The regression was a refusal after walking. Preserve its latency check,
  // then prove a flowing cell still leads to the source feeding it.
  const wrong = await context.call("use_bucket", { action: "fill", liquid: "water", ...refuse });
  if (wrong.result.status !== "failed" || !wrong.result.error.startsWith("[BUCKET_NOT_A_SOURCE]") || wrong.durationMs > 1_500) {
    return { status: "failed", detail: `Stone cell was not refused before walking: ${wrong.summary}` };
  }

  const filled = await context.call("use_bucket", { action: "fill", liquid: "water", ...cell });
  // Mine Labs independently checks the carried water bucket in the YAML goal.
  return {
    status: filled.result.status === "succeeded" ? "succeeded" : "failed",
    detail: `Stone correctly refused before walking; ${filled.summary}`,
  };
}
