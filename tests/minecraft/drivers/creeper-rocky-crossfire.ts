import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
  /** The longest the body may stay owned by a reflex before the request is made. */
  idleWithinTicks: ticksSchema,
});

/**
 * One request made into a fight that starts before the trial does. A reflex
 * may own the body at the start; the request waits, observing with
 * view_status, until nothing does, and is then made once. A body that never
 * comes free within the bound fails the trial rather than racing the reflex.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { action, input, expect, idleWithinTicks } = playerParams(context, requestSchema);
  let waited = 0;
  for (;;) {
    const { situation } = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
    if (situation.activity.owner === "idle") break;
    if (waited >= idleWithinTicks) {
      return { status: "failed", detail: `The body was still owned (${situation.activity.owner}) after ${waited} ticks; the request was never made.` };
    }
    await context.waitForTicks(5);
    waited += 5;
  }
  const output = await context.call(action, input);
  const { matches, detail } = checkExpectation(expect, output);
  return { status: matches ? "succeeded" : "failed", detail: `waited ${waited} ticks for an idle body; ${detail}` };
}
