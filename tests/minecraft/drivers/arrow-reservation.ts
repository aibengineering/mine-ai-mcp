import assert from "node:assert/strict";
import { viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";
import { run as runAction } from "./single-action.ts";

/** The fixture's sole bow has no Unbreaking or Mending: every shot costs durability. */
export const run: ScenarioRun = async (context) => {
  const bowDurability = async () => {
    const output = await context.call("view_status", {});
    const observed = viewStatusResultSchema.parse(output.result);
    assert.equal(observed.status, "succeeded", output.summary);
    const bows = observed.situation.inventory.stacks.filter((item) => item.name === "bow");
    assert.equal(bows.length, 1, "The original bow must remain the only carried bow.");
    const durability = bows[0]!.durability;
    assert.ok(durability, "Native bow durability must be available.");
    return durability;
  };
  const before = await bowDurability();
  assert.equal(before.remaining, before.maximum, "The hunt starts with an undamaged bow.");
  // Preserve the successful outcome AND hostile-interruption expectation.
  const completion = await runAction(context);
  if (completion.status !== "succeeded") return completion;
  const after = await bowDurability();
  assert.deepEqual(after, before, "No shot may spend bow durability, including during defensive interruptions.");
  return { status: "succeeded", detail: `${completion.detail}; native bow durability unchanged at ${after.remaining}/${after.maximum}.` };
};
