import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioCall, ScenarioContext } from "../scenario.ts";

const stepSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

const responseSchema = z.enum(["fight", "evade", "hide"]);

/**
 * What a request may say besides its steps.
 * - `waitTicks` lets an arranged fight or hazard begin before the first request.
 * - `idleWithinTicks` makes the first request wait, observing with
 *   `view_status`, until no reflex owns the body, so a request made into a
 *   running fight is made once rather than refused and repeated. A body that
 *   never comes free within the bound fails the trial.
 * - `holdTicks` keeps the session, and the runtime's reflexes, on the body
 *   after the last step. The host closes the runtime when the driver returns.
 * - `forbidResponses` reads the recorded hostile-reflex outcomes once the steps
 *   are done and fails on any response a policy step prohibited: an explicit
 *   prohibition is a contract the world cannot always witness, since a
 *   forbidden hide need not leave a block behind.
 */
const options = {
  waitTicks: ticksSchema.optional(),
  idleWithinTicks: ticksSchema.optional(),
  holdTicks: ticksSchema.optional(),
  forbidResponses: z.array(responseSchema).min(1).optional(),
};

/** The scenario-level request for a fixture's only actor. */
const sequenceSchema = z.strictObject({ ...options, actions: z.array(stepSchema).min(1) });

/** One pen's request: an idle pen declares only `waitTicks`. */
const penSchema = z.strictObject({ ...options, actions: z.array(stepSchema).optional() }).refine(
  ({ waitTicks, actions }) => waitTicks !== undefined || (actions?.length ?? 0) > 0,
  "declare waitTicks, actions, or both",
);

const POLICY_ACTION = "set_survival_policy";

const recentEventsSchema = z.object({
  status: z.literal("succeeded"),
  events: z.array(z.object({ type: z.string(), payload: z.unknown() })),
  remainingEventCount: z.number().int().nonnegative(),
});

const reflexOutcomeSchema = z.object({
  source: z.literal("hostile_reflex"),
  evidence: z.object({ outcome: z.object({ response: z.string(), outcome: z.string() }) }),
});

/**
 * YAML owns the steps and each step's expected result; stop at the first step
 * whose expectation fails. Mine Labs checks the final world.
 *
 * `set_survival_policy` refuses an edit without the current
 * `expected_revision`, which every action reply carries and no YAML can know in
 * advance, so a policy step that leaves it out is sent with the revision from
 * the latest reply (a `view_status` call when there is none yet), as a model
 * would.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const schema = "players" in context.scenario.params ? penSchema : sequenceSchema;
  const { waitTicks, idleWithinTicks, actions = [], holdTicks, forbidResponses } = playerParams(context, schema);
  if (waitTicks !== undefined) await context.waitForTicks(waitTicks);
  const summaries: string[] = waitTicks === undefined ? [] : [`waited ${waitTicks} ticks`];
  let latest: ScenarioCall | undefined;
  if (idleWithinTicks !== undefined) {
    const idle = await waitForIdleBody(context, idleWithinTicks);
    if (!idle.idle) {
      return { status: "failed", detail: `The body was still owned (${idle.owner}) after ${idle.waited} ticks; no request was made.` };
    }
    latest = idle.latest;
    summaries.push(`waited ${idle.waited} ticks for an idle body`);
  }
  for (const [index, { action, input, expect }] of actions.entries()) {
    let request = input;
    if (action === POLICY_ACTION && !("expected_revision" in input)) {
      if (latest?.survivalPolicy?.revision === undefined) latest = await context.call("view_status", {});
      const current = latest.survivalPolicy?.revision;
      if (current === undefined) throw new Error("No action reply carried the survival policy revision.");
      request = { ...input, expected_revision: current };
    }
    const output = await context.call(action, request);
    latest = output;
    const { matches, detail } = checkExpectation(expect, output);
    summaries.push(`${index + 1}. ${detail}`);
    if (!matches) return { status: "failed", detail: summaries.join("; ") };
  }
  if (holdTicks !== undefined) {
    await context.waitForTicks(holdTicks);
    summaries.push(`held ${holdTicks} ticks`);
  }
  if (forbidResponses !== undefined) {
    const responses = await reflexResponses(context);
    const forbidden = responses.filter((entry) => forbidResponses.some((name) => entry.startsWith(`${name}:`)));
    summaries.push(`reflex responses: ${responses.join(", ") || "none"}`);
    if (forbidden.length > 0) {
      return { status: "failed", detail: `Forbidden reflex response recorded (${forbidden.join(", ")}); ${summaries.join("; ")}` };
    }
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}

async function waitForIdleBody(context: ScenarioContext, withinTicks: number) {
  for (let waited = 0; ; waited += 5) {
    const latest = await context.call("view_status", {});
    const { owner } = viewStatusResultSchema.parse(latest.result).situation.activity;
    if (owner === "idle") return { idle: true as const, waited, latest };
    if (waited >= withinTicks) return { idle: false as const, waited, owner };
    await context.waitForTicks(5);
  }
}

/** Every hostile-reflex response recorded since the session began, oldest first. */
async function reflexResponses(context: ScenarioContext): Promise<string[]> {
  const responses: string[] = [];
  for (;;) {
    const page = recentEventsSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
    for (const event of page.events) {
      if (event.type !== "survival_outcome") continue;
      const outcome = reflexOutcomeSchema.safeParse(event.payload);
      if (outcome.success) {
        const { response, outcome: result } = outcome.data.evidence.outcome;
        responses.push(`${response}:${result}`);
      }
    }
    if (page.remainingEventCount === 0) return responses;
  }
}
