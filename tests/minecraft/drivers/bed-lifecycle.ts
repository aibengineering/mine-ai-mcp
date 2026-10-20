import assert from "node:assert/strict";
import { z } from "zod";
import { sleepResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
/**
 * `night`: sleep on a bed placed from inventory, then, with `thenWalkTo`,
 * walk to a standing bed and use it by day. `day`: wait for daylight, then
 * use the nearby standing bed.
 */
const penSchema = z.discriminatedUnion("case", [
  z.strictObject({ case: z.literal("night"), thenWalkTo: positionSchema.optional() }),
  z.strictObject({ case: z.literal("day"), dayWithinTicks: ticksSchema }),
]);

async function sleep(context: ScenarioContext) {
  const output = await context.call("sleep", {});
  const result = sleepResultSchema.parse(output.result);
  assert.equal(result.status, "succeeded", output.summary);
  return result.sleep!;
}

async function clock(context: ScenarioContext) {
  return viewStatusResultSchema.parse((await context.call("view_status", {})).result).situation.clock;
}

async function useByDay(context: ScenarioContext) {
  const day = await sleep(context);
  assert.ok(!day.placedBed, "By day the standing bed must be used, not a carried one.");
  assert.ok(day.respawnSet && !day.morning && !day.asleep, "By day a bed sets the respawn point without sleeping.");
}

/** Each sleep receipt must say what Minecraft did; the goals read the server's own respawn point. */
export const run: ScenarioRun = async (context) => {
  const pen = playerParams(context, penSchema);
  if (pen.case === "night") {
    const night = await sleep(context);
    assert.ok(night.placedBed, "The night's bed must come from inventory.");
    assert.ok(night.morning && night.respawnSet, "Sleeping at night must reach morning and set the respawn point.");
    const { phase, timeOfDay } = await clock(context);
    assert.equal(phase, "day", `The world must be in daylight after sleeping; time ${timeOfDay}.`);
    if (!pen.thenWalkTo) return { status: "succeeded", detail: "Placed a carried bed and slept to morning." };
    const walked = await context.call("navigate", { ...pen.thenWalkTo, range: 2, dig: false, scaffold: false });
    assert.equal(walked.result.status, "succeeded", walked.summary);
    await useByDay(context);
    return { status: "succeeded", detail: "Slept on a carried bed, walked off it and set the respawn point at a standing bed by day." };
  }
  // Another pen's sleep ends the night; observe the world until it has.
  let waited = 0;
  while ((await clock(context)).phase !== "day") {
    assert.ok(waited < pen.dayWithinTicks, `Daylight did not come within ${pen.dayWithinTicks} ticks.`);
    await context.waitForTicks(20);
    waited += 20;
  }
  await useByDay(context);
  return { status: "succeeded", detail: `Waited ${waited} ticks for daylight; set the respawn point at a standing bed without sleeping.` };
};
