import assert from "node:assert/strict";
import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  assert.ok(await standStill(context));
  const start = context.bot.entity.position.clone();
  const ambiguous = await new ActionRunner().run(
    createNavigateAction(context.bot, context.navigation),
    { x: 3, z: 0, range: 0 },
    context.signal,
  );
  assert.equal(ambiguous.result.status, "failed", "multiple floors require an explicit height");
  assert.match(ambiguous.result.error ?? "", /NAVIGATION_HEIGHT_REQUIRED/);
  assert.ok(context.bot.entity.position.distanceTo(start) < 0.1, "ambiguity must not move the bot");
  const output = await new ActionRunner().run(
    createNavigateAction(context.bot, context.navigation),
    { x: 3, y: -54, z: 0, range: 0 },
    context.signal,
  );
  assert.equal(output.result.status, "succeeded", JSON.stringify(output));
  assert.equal(context.bot.entity.position.floored().y, -54, "arrival must be above the roof, not on the cave floor");
  return { status: "succeeded", detail: JSON.stringify(output) };
};
