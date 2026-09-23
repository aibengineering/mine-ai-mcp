import { z } from "zod";
import { exploreFrontierResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({ heading: z.number(), chunks: z.number().int().positive() });

/** Success must include the requested expansion, not just a successful action status. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const request = requestSchema.parse(context.scenario.params);
  const output = await context.call("explore_frontier", request);
  const result = exploreFrontierResultSchema.parse(output.result);
  const expanded = result.explored.expandedChunks;
  return {
    status: result.status === "succeeded" && expanded >= request.chunks ? "succeeded" : "failed",
    detail: `${output.summary}; expanded ${expanded}/${request.chunks} chunk columns`,
  };
}
