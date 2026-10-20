import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioCall, ScenarioContext } from "../scenario.ts";

const stepSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

const responseSchema = z.enum(["fight", "evade", "hide"]);

/**
 * `drivers/action-sequence.ts`, for fixtures whose subject is a survival
 * policy the model sets. `set_survival_policy` refuses an edit without the
 * current `expected_revision`, which every action reply carries and no YAML
 * can know in advance, so a policy step that leaves it out is sent with the
 * revision from the latest reply (a `view_status` call when there is none
 * yet), as a model would. `forbidResponses` then reads the recorded hostile
 * reflex outcomes once the steps are done, and fails on any response the
 * policy prohibited: an explicit prohibition is a contract the world cannot
 * always witness, since a forbidden hide need not leave a block behind.
 * `idleWithinTicks` makes the first request wait, observing with
 * `view_status`, until no reflex owns the body, so a request made into a
 * running fight is made once rather than refused and repeated.
 * `holdTicks` keeps the session, and its reflexes, open after the last step,
 * for a pen that would otherwise sit with no reflexes beside live hostiles
 * while the rest of the trial runs.
 */
const penSchema = z.strictObject({
  waitTicks: ticksSchema.optional(),
  idleWithinTicks: ticksSchema.optional(),
  actions: z.array(stepSchema).min(1),
  forbidResponses: z.array(responseSchema).min(1).optional(),
  holdTicks: ticksSchema.optional(),
});

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

function revision(output: ScenarioCall | undefined): string | undefined {
  return output?.survivalPolicy?.revision;
}

/** Every hostile-reflex response recorded since the session began, oldest first. */
async function reflexResponses(context: ScenarioContext): Promise<string[]> {
  const responses: string[] = [];
  for (;;) {
    const output = await context.call("read_recent_events", { limit: 100 });
    const page = recentEventsSchema.parse(output.result);
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

export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { waitTicks, idleWithinTicks, actions, forbidResponses, holdTicks } = playerParams(context, penSchema);
  if (waitTicks !== undefined) await context.waitForTicks(waitTicks);
  const summaries: string[] = waitTicks === undefined ? [] : [`waited ${waitTicks} ticks`];
  let latest: ScenarioCall | undefined;
  if (idleWithinTicks !== undefined) {
    let waited = 0;
    for (;;) {
      latest = await context.call("view_status", {});
      const { situation } = viewStatusResultSchema.parse(latest.result);
      if (situation.activity.owner === "idle") break;
      if (waited >= idleWithinTicks) {
        return { status: "failed", detail: `The body was still owned (${situation.activity.owner}) after ${waited} ticks; no request was made.` };
      }
      await context.waitForTicks(5);
      waited += 5;
    }
    summaries.push(`waited ${waited} ticks for an idle body`);
  }
  for (const [index, { action, input, expect }] of actions.entries()) {
    let request = input;
    if (action === POLICY_ACTION && !("expected_revision" in input)) {
      latest = revision(latest) === undefined ? await context.call("view_status", {}) : latest;
      const current = revision(latest);
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
