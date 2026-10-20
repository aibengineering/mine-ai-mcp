import assert from "node:assert/strict";
import { z } from "zod";
import { dropItemResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { checkExpectation, expectationSchema, playerParams, ticksSchema } from "../driver-params.ts";
import type { ScenarioRun } from "../scenario.ts";

const stepSchema = z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  expect: expectationSchema,
});

/**
 * One pen's requests, then a wait long enough for native pickup to act on
 * anything left within reach. Every successful disposal into a hole must still
 * have all it dropped lying at the hole's bottom when the wait ends.
 */
const penSchema = z.strictObject({
  actions: z.array(stepSchema).min(1),
  settleTicks: ticksSchema.default(100),
});

type Hole = { x: number; y: number; z: number; dropped: Map<string, number> };

export const run: ScenarioRun = async (context) => {
  const { actions, settleTicks } = playerParams(context, penSchema);
  const holes: Hole[] = [];
  const summaries: string[] = [];
  for (const [index, { action, input, expect }] of actions.entries()) {
    const output = await context.call(action, input);
    const { matches, detail } = checkExpectation(expect, output);
    summaries.push(`${index + 1}. ${detail}`);
    if (!matches) return { status: "failed", detail: summaries.join("; ") };
    if (action !== "drop_item" || output.result.status !== "succeeded") continue;
    const { drop } = dropItemResultSchema.parse(output.result);
    if (!drop.hole) continue;
    const dropped = new Map(drop.dropped.filter((entry) => entry.dropped > 0).map((entry) => [entry.item, entry.dropped]));
    holes.push({ ...drop.hole, dropped });
  }
  assert.ok(holes.length > 0, "The pen must make at least one disposal hole.");

  // Native pickup acts within a second of the throw delay; five seconds is well past it.
  await context.waitForTicks(settleTicks);
  const status = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(status.status, "succeeded");
  const items = status.situation.nearby.droppedItems;
  for (const hole of holes) {
    for (const [name, count] of hole.dropped) {
      const inside = items
        .filter((item) => item.name === name && Math.floor(item.position.x) === hole.x &&
          Math.floor(item.position.z) === hole.z && Math.abs(item.position.y - hole.y) < 0.5)
        .reduce((sum, item) => sum + item.count, 0);
      assert.equal(inside, count, `${name} at the bottom of the hole at ${hole.x},${hole.y},${hole.z}: ${inside}, but the receipt dropped ${count}`);
    }
  }
  return { status: "succeeded", detail: `${summaries.join("; ")}; after ${settleTicks} ticks every discard lay at its hole's bottom` };
};
