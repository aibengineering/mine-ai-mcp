import assert from "node:assert/strict";
import { z } from "zod";
import { tunnelToResultSchema, queryBotDataResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const paramsSchema = z.strictObject({ target: positionSchema, searchId: z.string().min(1) });

/**
 * The §10 acceptance: a stronghold end-portal room buried under a static ocean,
 * with lava directly under the frame. From the dry shore, tunnel_to must carve a
 * walkable diagonal staircase down to a foothold beside the frame without ever
 * breaching the water above the route or the lava beneath it, and record the dry
 * mouth and the portal-room exit as durable landmarks for a later leg.
 */
export const run: ScenarioRun = async (context: ScenarioContext) => {
  const { target, searchId } = paramsSchema.parse(context.scenario.params);
  await context.waitForTicks(20);

  const call = await context.call("tunnel_to", { target, search_id: searchId });
  const result = tunnelToResultSchema.parse(call.result);

  assert.equal(result.status, "succeeded", call.summary);
  assert.equal(result.reachedTarget, true, `The bot must end standing at the frame; ${call.summary}`);
  assert.equal(result.touchedWater, false, "The staircase must never breach the ocean above the route.");
  assert.equal(result.touchedLava, false, "The staircase must never breach the lava under the frame.");
  assert.ok(result.mouth, "A dry mouth must be established.");
  assert.ok(result.portalExit, "The portal-room exit must be recorded.");
  assert.ok(result.staircase.descent > 0, "The staircase must actually descend toward the frame.");

  // The two durable landmarks persist under the search id, shared with
  // locate_stronghold, so a later leg can re-read the dug approach.
  const landmarks = queryBotDataResultSchema.parse(
    (
      await context.call("query_bot_data", {
        sql: `SELECT kind, position_json FROM stronghold_landmarks WHERE search_id = '${searchId}' ORDER BY kind`,
      })
    ).result,
  );
  assert.equal(landmarks.status, "succeeded", "The landmarks must be queryable from bot data.");
  const kinds = landmarks.query.rows.map((row) => row[0]);
  assert.deepEqual(kinds, ["mouth", "portal_exit"], `Both landmarks must persist; saw ${kinds.join(", ") || "none"}.`);

  return {
    status: "succeeded",
    detail:
      `Carved a dry staircase of ${result.staircase.segments} hops, descending ${result.staircase.descent} blocks to the frame ` +
      `without touching water or lava; mouth and portal_exit landmarks saved under '${searchId}'.`,
  };
};
