/**
 * Two `use_bucket` fills: one named at a flowing cell, which must come
 * back with water from the source feeding it, and one named at solid stone,
 * which must be refused before any route is run.
 */
import { USE_BUCKET } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";

import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const cellSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ cell: cellSchema, refuse: cellSchema });

/** A refusal taken before the walk is a refusal taken in milliseconds, not seconds. */
const IMMEDIATE_MS = 1_500;

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "bucket");
  try {
    const bucket = runtime.actions.find((action) => action.name === USE_BUCKET);
    if (!bucket) throw new Error("The fill-flowing scenario could not find use_bucket.");

    const wrong = await runtime.run(bucket, { action: "fill", liquid: "water", ...params.refuse }, context.signal);
    const wrongError = "error" in wrong.result ? wrong.result.error : "";
    context.log(`stone cell: ${wrong.result.status} in ${wrong.durationMs} ms — ${wrongError}`);
    if (wrong.result.status === "succeeded" || wrong.durationMs > IMMEDIATE_MS) {
      return {
        status: "failed",
        detail: `a stone cell was not refused before the walk: ${wrong.result.status} in ${wrong.durationMs} ms`,
      };
    }

    const { result, durationMs } = await runtime.run(
      bucket,
      { action: "fill", liquid: "water", ...params.cell },
      context.signal,
    );
    const error = "error" in result ? result.error : "";
    const scooped = (result as { bucket?: { target?: { x: number; y: number; z: number } } }).bucket?.target;
    const detail = `flowing cell: ${result.status} in ${durationMs} ms; scooped ${JSON.stringify(scooped)}${error ? ` — ${error}` : ""}`;
    context.log(detail);
    // The named cell is flowing, so success means the source feeding it was taken.
    const filled = context.bot.inventory.items().some((item) => item.name === "water_bucket");
    return { status: result.status === "succeeded" && filled ? "succeeded" : "failed", detail };
  } finally {
    await runtime.close();
  }
}
