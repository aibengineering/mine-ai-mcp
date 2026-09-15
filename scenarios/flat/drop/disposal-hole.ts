import assert from "node:assert/strict";
import { z } from "zod";
import { createDropItemAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { carriedCount } from "../../../src/world/inventory-count.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  const { expected } = z.object({ expected: z.enum(["dropped", "unavailable"]) }).parse(context.scenario.params);
  assert.ok(await standStill(context));
  const observeItems = () =>
    Object.values(bot.entities).flatMap((entity) => {
      if (entity.name !== "item") return [];
      const item = entity.getDroppedItem();
      return item ? [{ name: item.name, count: item.count, position: entity.position }] : [];
    });
  const output = await new ActionRunner().run(
    createDropItemAction(bot, navigation),
    {
      items: [{ item_name: "rotten_flesh", count: 12 }, { item_name: "cobblestone" }],
      in_a_hole: true,
    },
    signal,
  );
  log(`DISPOSAL_RESULT ${JSON.stringify(output)}`);
  log(`DISPOSAL_ITEMS ${JSON.stringify({ items: observeItems(), yaw: bot.entity.yaw, pitch: bot.entity.pitch })}`);
  if (expected === "unavailable") {
    assert.equal(output.result.status, "failed");
    assert.match(output.result.error ?? "", /DROP_HOLE_UNAVAILABLE/);
    assert.equal(carriedCount(bot, "rotten_flesh"), 16);
    assert.equal(carriedCount(bot, "cobblestone"), 70);
    return { status: "succeeded", detail: JSON.stringify(output) };
  }
  assert.equal(output.result.status, "succeeded", JSON.stringify(output));
  const hole = output.result.drop.hole;
  assert.ok(hole);
  // Native pickup remains active for five seconds, well past its throw delay.
  await bot.waitForTicks(100);
  signal.throwIfAborted();
  assert.equal(carriedCount(bot, "rotten_flesh"), 4);
  assert.equal(carriedCount(bot, "cobblestone"), 0);
  assert.equal(bot.entity.onGround, true);
  assert.equal(bot.entity.position.floored().y, -60, "The bot must remain on the rim.");
  const contents = Object.values(bot.entities).flatMap((entity) => {
    if (entity.name !== "item") return [];
    const item = entity.getDroppedItem();
    if (!item) return [];
    return [{ name: item.name, count: item.count, position: entity.position }];
  });
  for (const [name, count] of [
    ["rotten_flesh", 12],
    ["cobblestone", output.result.drop.dropped.find((entry) => entry.item === "cobblestone")!.dropped],
  ] as const) {
    const inside = contents.filter(
      (item) =>
        item.name === name &&
        Math.floor(item.position.x) === hole.x &&
        Math.floor(item.position.z) === hole.z &&
        Math.abs(item.position.y - hole.y) < 0.3,
    );
    assert.equal(
      inside.reduce((sum, item) => sum + item.count, 0),
      count,
      `${name} must stay at the bottom.`,
    );
  }
  return { status: "succeeded", detail: JSON.stringify({ output, contents, position: bot.entity.position }) };
};
