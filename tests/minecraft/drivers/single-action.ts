import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { checkExpectation, expectationSchema, playerParams } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

/**
 * One action and its expected result belong in YAML, including deliberate
 * refusals. Mine Labs separately checks the declared world goals. Expecting
 * failure must never turn a runtime failure or cancellation into a passing test.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { action, input, expect } = playerParams(context, requestSchema);
  const output = await context.call(action, input);
  const { matches, detail } = checkExpectation(expect, output);
  return { status: matches ? "succeeded" : "failed", detail };
}
