import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  actions: z.array(z.strictObject({
    action: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
  })).min(1),
});

/** YAML owns the steps; stop at the first failure. Mine Labs checks the final world. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { actions } = requestSchema.parse(context.scenario.params);
  const summaries: string[] = [];
  for (const [index, { action, input }] of actions.entries()) {
    const output = await context.call(action, input);
    summaries.push(`${index + 1}. ${output.summary}`);
    if (output.result.status !== "succeeded") {
      return { status: "failed", detail: summaries.join("; ") };
    }
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
