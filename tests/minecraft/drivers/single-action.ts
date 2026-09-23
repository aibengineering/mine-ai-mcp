import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
});

/**
 * Shared by every scenario that needs one successful action: choosing another
 * action or input belongs in YAML, not in another driver file. Mine Labs
 * separately checks the declared world goals.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { action, input } = requestSchema.parse(context.scenario.params);
  const output = await context.call(action, input);
  return {
    status: output.result.status === "succeeded" ? "succeeded" : "failed",
    detail: output.summary,
  };
}
