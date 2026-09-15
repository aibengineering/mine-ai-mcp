/**
 * Fill a bucket, pour it, and fill it again, through the production runtime's
 * actions — the same ones the MCP model calls.
 *
 * Making obsidian is not here any more: casting water onto lava is how
 * obsidian is obtained, so it belongs to the process that obtains blocks, and
 * `collect_block obsidian` drives it. What is left is the bucket's own
 * two operations and the evidence that a pour onto a lava pool forms obsidian.
 */
import { COLLECT_BLOCK, USE_BUCKET, type Action } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";

import { openRuntime } from "./runtime.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

const cellSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

const paramsSchema = z.strictObject({
  /** The cell the water is poured into; the pour spreads from there over the pool. */
  pour: cellSchema,
  /** The cell a refill scoops from, which is the poured cell unless the fixture says otherwise. */
  refill: cellSchema.optional(),
  /** How much obsidian is mined afterwards, to prove the pour left something takeable. */
  obsidian: z.number().int().nonnegative().default(0),
});

/** Flowing water without a source is gone within a few seconds; the dig policy needs it gone. */
const DRAIN_WAIT_MS = 6_000;

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "bucket");
  const steps: string[] = [];
  try {
    const bucket = runtime.actions.find((action) => action.name === USE_BUCKET);
    const collect = runtime.actions.find((action) => action.name === COLLECT_BLOCK);
    if (!bucket || !collect) throw new Error("The bucket scenario could not find its production actions.");

    const step = async (label: string, request: Record<string, unknown>, action: Action) => {
      const { result, durationMs } = await runtime.run(action, request, context.signal);
      const error = "error" in result ? result.error : "";
      const line = `${label}: ${result.status} in ${durationMs} ms${error ? ` — ${error}` : ""}`;
      steps.push(line);
      context.log(line);
      return result;
    };

    const fill = await step("fill", { action: "fill", liquid: "water" }, bucket);
    if (fill.status !== "succeeded") return { status: "failed", detail: steps.join("; ") };
    const pour = await step("pour", { action: "pour", liquid: "water", ...params.pour }, bucket);
    if (pour.status !== "succeeded") return { status: "failed", detail: steps.join("; ") };
    const formed = (pour as { bucket?: { obsidianFormed?: number } }).bucket?.obsidianFormed ?? 0;
    context.log(`obsidian formed: ${formed}`);
    const refill = await step("refill", { action: "fill", liquid: "water", ...(params.refill ?? params.pour) }, bucket);
    if (refill.status !== "succeeded") return { status: "failed", detail: steps.join("; ") };
    await new Promise((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));

    if (params.obsidian === 0) return { status: "succeeded", detail: `obsidian formed ${formed}; ${steps.join("; ")}` };
    const mined = await step("collect", { block_name: "obsidian", count: params.obsidian, scaffold: false }, collect);
    const succeeded = mined.status === "succeeded" && formed >= params.obsidian;
    return { status: succeeded ? "succeeded" : "failed", detail: `obsidian formed ${formed}; ${steps.join("; ")}` };
  } finally {
    await runtime.close();
  }
}
