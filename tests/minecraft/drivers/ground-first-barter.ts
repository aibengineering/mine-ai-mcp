import assert from "node:assert/strict";
import { z } from "zod";
import { barterResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import { playerParams } from "../driver-params.ts";
import type { ScenarioRun } from "../scenario.ts";

/** One pen's barter, and the gold it must cost: none when the reward already lies on the ground. */
const requestSchema = z.strictObject({
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  gold_budget: z.number().int().nonnegative(),
  gold_spent: z.number().int().nonnegative(),
});

/**
 * Barter with the pen's own adult piglin and compare the gold actually carried
 * before and after with the receipt: spent, offered and observed must all equal
 * the pen's expectation.
 */
export const run: ScenarioRun = async (context) => {
  const { gold_spent: expected, ...request } = playerParams(context, requestSchema);
  const before = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(before.status, "succeeded");
  const piglin = before.situation.nearby.mobs.find((mob) => mob.name === "piglin" && mob.age === "adult");
  assert.ok(piglin, "The fixture must offer a real, loaded adult piglin to barter with.");
  const output = await context.call("barter", { ...request, piglin_id: piglin.nearest.entityId });
  const result = barterResultSchema.parse(output.result);
  const after = viewStatusResultSchema.parse((await context.call("view_status", {})).result);
  assert.equal(after.status, "succeeded");
  const goldCount = (stacks: typeof before.situation.inventory.stacks) => stacks
    .filter((item) => item.name === "gold_ingot" && (item.location === "main" || item.location === "hotbar"))
    .reduce((sum, item) => sum + item.count, 0);
  const actualGoldSpent = goldCount(before.situation.inventory.stacks) - goldCount(after.situation.inventory.stacks);
  assert.equal(result.status, "succeeded", output.summary);
  assert.equal(actualGoldSpent, expected, "Gold actually spent");
  assert.equal(result.barter.goldSpent, actualGoldSpent, "Receipt's gold spent");
  assert.equal(result.barter.goldOffers, expected, "Receipt's gold offers");
  return { status: "succeeded", detail: `Observed ${actualGoldSpent} gold spent; ${output.summary}` };
};
