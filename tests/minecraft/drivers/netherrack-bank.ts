import assert from "node:assert/strict";
import { viewBlocksResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";
import { run as runAction } from "./single-action.ts";

/** Count the actual bank before and after: inventory alone cannot expose excessive excavation. */
export const run: ScenarioRun = async (context) => {
  const remainingBank = async () => {
    const output = await context.call("view_blocks", {
      box: { x: 0, y: -56, z: 0, half_width: 4, half_height: 3 },
    });
    const observed = viewBlocksResultSchema.parse(output.result);
    assert.equal(observed.status, "succeeded", output.summary);
    assert.ok(observed.blocks.box);
    return observed.blocks.box.layers.flatMap((layer) => layer.rows.flatMap((row) => row.blocks))
      .filter((block) => block === "netherrack").length;
  };
  const before = await remainingBank();
  assert.equal(before, 565, "The nine-by-seven-by-nine bank has only the two starting air cells.");
  const completion = await runAction(context);
  if (completion.status !== "succeeded") return completion;
  const removed = before - await remainingBank();
  // Harvesting half a stack must not excavate more than a whole stack. This
  // allows incidental route clearing without tying the test to a retry counter.
  assert.ok(removed >= 32 && removed <= 64, `Collecting 32 netherrack removed ${removed} bank blocks; expected 32..64.`);
  return { status: "succeeded", detail: `${completion.detail}; observed ${removed}/565 bank blocks removed (maximum 64).` };
};
