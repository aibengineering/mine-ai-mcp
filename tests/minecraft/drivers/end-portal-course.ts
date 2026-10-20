import assert from "node:assert/strict";
import { z } from "zod";
import { activatePortalResultSchema, portalEntryResultSchema, sleepResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioCall, ScenarioContext, ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ frame: positionSchema, portal: positionSchema, distantWithin: z.number().nonnegative() });

async function status(context: ScenarioContext) {
  const output = await context.call("view_status", {});
  const { situation } = viewStatusResultSchema.parse(output.result);
  return situation;
}

function refused(output: ScenarioCall, code: string) {
  assert.equal(output.result.status, "failed", output.summary);
  assert.ok(output.result.status === "failed" && output.result.error.includes(code), `Expected ${code}; ${output.summary}`);
}

/**
 * Activate an End portal from inside its opening, then cross only once a
 * personal respawn bed near the portal is confirmed. Every refusal must leave
 * the bot in the Overworld; the crossing must land it able to walk in the End.
 */
export const run: ScenarioRun = async (context) => {
  const { frame, portal, distantWithin } = paramsSchema.parse(context.scenario.params);
  const carriedEyes = (situation: Awaited<ReturnType<typeof status>>) => situation.inventory.stacks
    .filter((stack) => stack.name === "ender_eye").reduce((sum, stack) => sum + stack.count, 0);

  // From a cell inside the opening: step out, fill the ten empty sockets, never fall in.
  const first = activatePortalResultSchema.parse((await context.call("activate_portal", frame)).result);
  assert.equal(first.status, "succeeded");
  assert.ok(first.portal.kind === "end" && first.portal.activated && first.portal.eyesAfter === 12, "Activation must fill all twelve sockets.");
  let situation = await status(context);
  assert.equal(situation.dimension, "overworld", "Activation must not enter the portal.");
  assert.equal(carriedEyes(situation), 0, "Ten eyes fill ten sockets, none spent twice.");

  // A repeat recognises the active portal.
  const repeat = activatePortalResultSchema.parse((await context.call("activate_portal", frame)).result);
  assert.equal(repeat.status, "succeeded");
  assert.ok(repeat.portal.kind === "end" && !repeat.portal.activated, "A repeat must report the portal already active.");

  refused(await context.call("enter_end_portal", portal), "END_PORTAL_RESPAWN_UNKNOWN");
  assert.equal((await status(context)).dimension, "overworld");

  const slept = sleepResultSchema.parse((await context.call("sleep", {})).result);
  assert.ok(slept.status === "succeeded" && slept.sleep.morning && slept.sleep.respawnSet, "Sleep at the nearby bed must confirm the respawn point.");

  refused(await context.call("enter_end_portal", { ...portal, respawn_within: distantWithin }), "END_PORTAL_RESPAWN_DISTANT");
  assert.equal((await status(context)).dimension, "overworld");

  const crossed = await context.call("enter_end_portal", portal);
  const entry = portalEntryResultSchema.parse(crossed.result);
  assert.equal(entry.status, "succeeded", crossed.summary);
  situation = await status(context);
  assert.equal(situation.dimension, "the_end");

  // Ordinary navigation keeps working after the crossing.
  const { x, y, z } = situation.position;
  const walked = await context.call("navigate", { x: Math.floor(x) + 1, y: Math.floor(y), z: Math.floor(z), range: 0, dig: false, scaffold: false });
  assert.equal(walked.result.status, "succeeded", walked.summary);
  assert.equal((await status(context)).dimension, "the_end");
  return { status: "succeeded", detail: "Activated from inside the opening; refused unknown and distant respawns; crossed after a near bed and walked in the End." };
};
