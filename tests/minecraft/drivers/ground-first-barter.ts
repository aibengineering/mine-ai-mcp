import assert from "node:assert/strict";
import { barterResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

/** An existing reward must be collected without spending gold or offering it to a piglin. */
export const run: ScenarioRun = async (context) => {
  const before = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(before.status, "succeeded");
  const piglin = before.situation.nearby.mobs.find((mob) => mob.name === "piglin" && mob.age === "adult");
  assert.ok(piglin, "The fixture must offer a real, loaded adult piglin to barter with.");
  const output = await context.call("barter", { ...context.scenario.params, piglin_id: piglin.nearest.entityId });
  const result = barterResultSchema.parse(output.result);
  const after = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(after.status, "succeeded");
  const goldCount = (stacks: typeof before.situation.inventory.stacks) => stacks
    .filter((item) => item.name === "gold_ingot" && (item.location === "main" || item.location === "hotbar"))
    .reduce((sum, item) => sum + item.count, 0);
  const actualGoldSpent = goldCount(before.situation.inventory.stacks) - goldCount(after.situation.inventory.stacks);
  assert.equal(result.status, "succeeded", output.summary);
  assert.equal(actualGoldSpent, 0);
  assert.equal(result.barter.goldSpent, actualGoldSpent);
  assert.equal(result.barter.goldOffers, 0);
  return { status: "succeeded", detail: `Observed ${actualGoldSpent} gold spent; ${output.summary}` };
};
