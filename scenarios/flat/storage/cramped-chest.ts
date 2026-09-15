import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import {
  ActionRunner,
  SqlBotData,
  createUseContainerAction,
  createPlaceBlockAction,
  createCollectBlockAction,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  assert.ok(await standStill(context));
  using data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "cramped-chest", scope: { kind: "shared" } },
  });
  const runner = new ActionRunner();
  const use = createUseContainerAction(bot, navigation, data);
  const blocked = await runner.run(use, { x: 1, y: -59, z: 0 }, signal);
  assert.equal(blocked.result.status, "failed");
  assert.match(blocked.result.error ?? "", /CHEST_BLOCKED.*deepslate/);
  context.log(`Blocked chest refused: ${blocked.result.error}`);
  assert.ok(bot.inventory.emptySlotCount() <= 5, "fixture must exercise the old capacity refusal");
  const clear = await runner.run(
    createCollectBlockAction(bot, navigation),
    { block_name: "deepslate", x: 1, y: -58, z: 0 },
    signal,
  );
  assert.equal(clear.result.status, "succeeded", JSON.stringify(clear));
  assert.equal(bot.blockAt(new Vec3(1, -58, 0))?.name, "air");
  const opened = await runner.run(use, { x: 1, y: -59, z: 0 }, signal);
  assert.equal(opened.result.status, "succeeded", JSON.stringify(opened));
  const placed = await runner.run(createPlaceBlockAction(bot, navigation), { block_name: "chest" }, signal);
  assert.equal(placed.result.status, "succeeded", JSON.stringify(placed));
  assert.ok("placement" in placed.result);
  const position = placed.result.placement.target;
  const inspected = await runner.run(use, position, signal);
  assert.equal(inspected.result.status, "succeeded", JSON.stringify(inspected));
  return {
    status: "succeeded",
    detail: `Cleared and opened blocked chest with nearly full inventory; nearby chest at ${JSON.stringify(position)} also opened.`,
  };
};
