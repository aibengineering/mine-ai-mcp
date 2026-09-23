import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: z.strictObject({
    status: z.enum(["succeeded", "partial", "failed"]),
    errorContains: z.string().min(1).optional(),
    interruptionContains: z.string().min(1).optional(),
  }).default({ status: "succeeded" }),
});

/**
 * One action and its expected result belong in YAML, including deliberate
 * refusals. Mine Labs separately checks the declared world goals. Expecting
 * failure must never turn a runtime failure or cancellation into a passing test.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { action, input, expect } = requestSchema.parse(context.scenario.params);
  const output = await context.call(action, input);
  const { result } = output;
  if (("kind" in result && result.kind === "runtime_failure") || result.status === "cancelled") {
    return { status: "failed", detail: output.summary };
  }
  const error = result.status === "succeeded" ? "" : result.error;
  const interruption = expect.interruptionContains;
  const matches = result.status === expect.status &&
    (expect.errorContains === undefined || error.includes(expect.errorContains)) &&
    (interruption === undefined ||
      output.interruptions?.some((reason) => reason.includes(interruption)) === true);
  const expected = [
    `Expected ${expect.status}`,
    expect.errorContains && `error containing ${JSON.stringify(expect.errorContains)}`,
    interruption && `interruption containing ${JSON.stringify(interruption)}`,
  ].filter(Boolean).join(" with ");
  return {
    status: matches ? "succeeded" : "failed",
    detail: matches ? output.summary : `${expected}; ${output.summary}`,
  };
}
