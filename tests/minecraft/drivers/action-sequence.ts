import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const stepSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

/** The scenario-level request for a fixture's only actor. */
const sequenceSchema = z.strictObject({
  waitTicks: ticksSchema.optional(),
  actions: z.array(stepSchema).min(1),
});

/** One pen's request: an idle pen declares only `waitTicks`. */
const penSchema = z.strictObject({
  waitTicks: ticksSchema.optional(),
  actions: z.array(stepSchema).optional(),
}).refine(
  ({ waitTicks, actions }) => waitTicks !== undefined || (actions?.length ?? 0) > 0,
  "declare waitTicks, actions, or both",
);

/**
 * YAML owns the steps and each step's expected result; stop at the first step
 * whose expectation fails. Mine Labs checks the final world.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const schema = "players" in context.scenario.params ? penSchema : sequenceSchema;
  const { waitTicks, actions = [] } = playerParams(context, schema);
  // A leading wait lets the arranged fight or hazard begin before the first request.
  if (waitTicks !== undefined) await context.waitForTicks(waitTicks);
  const summaries: string[] = waitTicks === undefined ? [] : [`waited ${waitTicks} ticks`];
  for (const [index, { action, input, expect }] of actions.entries()) {
    const output = await context.call(action, input);
    const { matches, detail } = checkExpectation(expect, output);
    summaries.push(`${index + 1}. ${detail}`);
    if (!matches) return { status: "failed", detail: summaries.join("; ") };
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
