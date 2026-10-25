import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioContext } from "../scenario.ts";

const stepSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

const requestSchema = z.strictObject({
  /**
   * The longest a reflex may own the body before the first request. A live
   * spawner beside the start can wake before the trial does; the request then
   * waits for an idle body once, and is never re-issued.
   */
  idleWithinTicks: ticksSchema,
  actions: z.array(stepSchema).min(1),
  /**
   * A timed step and the slowest rate it may average: `count` items over the
   * action's own duration. Mine Labs' hasItem goals check the items themselves.
   */
  rate: z.strictObject({
    step: z.number().int().nonnegative(),
    count: z.number().int().positive(),
    minimumPerMinute: z.number().positive(),
  }).optional(),
  /** Ticks to keep the reflexes after the last step, for fire still in flight. */
  holdTicks: ticksSchema.optional(),
});

/**
 * An ordered Nether expedition: a hunt at a live spawner or among endermen,
 * the trip home, and an optional rate on the hunt. A hunt that finishes, but at
 * a crawl, is the 2026-09-07 fortress failure the rate guards.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { idleWithinTicks, actions, rate, holdTicks } = playerParams(context, requestSchema);
  if (rate && rate.step >= actions.length) throw new Error(`rate.step ${rate.step} names no step.`);
  let waited = 0;
  for (;;) {
    const { situation } = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
    if (situation.activity.owner === "idle") break;
    if (waited >= idleWithinTicks) {
      return { status: "failed", detail: `The body was still owned (${situation.activity.owner}) after ${waited} ticks; nothing was requested.` };
    }
    await context.waitForTicks(5);
    waited += 5;
  }
  const summaries = [`waited ${waited} ticks for an idle body`];
  for (const [index, { action, input, expect }] of actions.entries()) {
    const output = await context.call(action, input);
    const { matches, detail } = checkExpectation(expect, output);
    summaries.push(`${index + 1}. ${detail}`);
    if (!matches) return { status: "failed", detail: summaries.join("; ") };
    if (rate?.step === index) {
      const minutes = output.durationMs / 60_000;
      const perMinute = rate.count / minutes;
      summaries.push(`${rate.count} in ${minutes.toFixed(1)} min: ${perMinute.toFixed(2)} per minute (minimum ${rate.minimumPerMinute})`);
      if (perMinute < rate.minimumPerMinute) return { status: "failed", detail: summaries.join("; ") };
    }
  }
  if (holdTicks !== undefined) {
    await context.waitForTicks(holdTicks);
    summaries.push(`held ${holdTicks} ticks`);
  }
  return { status: "succeeded", detail: summaries.join("; ") };
}
