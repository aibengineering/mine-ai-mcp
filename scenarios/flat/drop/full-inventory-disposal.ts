import assert from "node:assert/strict";
import { dropItemResultSchema, huntMobResultSchema } from "@aibengineering/mine-ai-mcp";
import { observe } from "../../default/nether/hazards/pit.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  assert.ok(await standStill(context));
  for (let slot = 0; slot < 27; slot++) bot.chat(`/item replace entity @s inventory.${slot} with netherrack 64`);
  for (let slot = 1; slot < 9; slot++) bot.chat(`/item replace entity @s hotbar.${slot} with netherrack 64`);
  bot.chat("/item replace entity @s hotbar.0 with diamond_pickaxe");
  await observe(bot, () => bot.inventory.emptySlotCount() === 0, "36 occupied slots");
  bot.chat('/summon item 0.5 -60 -3.5 {Item:{id:"minecraft:white_wool",count:1},PickupDelay:0s}');
  await observe(bot, () => Object.values(bot.entities).some((entity) => entity.name === "item"), "dropped wool");
  await using runtime = await openRuntime(context, "full-inventory-disposal");
  const hunt = runtime.actions.find((action) => action.name === "collect_mob_drop")!;
  const drop = runtime.actions.find((action) => action.name === "drop_item")!;
  const request = { mob_name: "sheep", drop_name: "white_wool", count: 1 };
  const before = huntMobResultSchema.parse((await runtime.run(hunt, request, signal)).result);
  log(`FULL_PICKUP ${JSON.stringify(before)}`);
  assert.equal(before.status, "failed");
  assert.match(before.error ?? "", /INVENTORY_FULL/);
  assert.equal(before.hunt.targetsEngaged, 0);
  const disposal = dropItemResultSchema.parse(
    (
      await runtime.run(
        drop,
        {
          items: [{ item_name: "netherrack", count: 192 }],
          in_a_hole: true,
        },
        signal,
      )
    ).result,
  );
  log(`DISPOSAL ${JSON.stringify(disposal)}`);
  assert.equal(disposal.status, "succeeded");
  assert.ok(disposal.drop.freeSlotsAfter > 0);
  const after = huntMobResultSchema.parse((await runtime.run(hunt, request, signal)).result);
  log(`PICKUP_AFTER_DISPOSAL ${JSON.stringify(after)}`);
  assert.equal(after.status, "succeeded");
  assert.equal(after.hunt.gained, 1);
  assert.equal(after.hunt.targetsEngaged, 0);
  const navigate = runtime.actions.find((action) => action.name === "navigate")!;
  const returned = await runtime.run(navigate, { x: 0, y: -60, z: 2, range: 0, dig: false, scaffold: false }, signal);
  assert.equal(returned.result.status, "succeeded", JSON.stringify(returned));
  await bot.waitForTicks(100);
  assert.equal(bot.inventory.count(bot.registry.itemsByName.netherrack!.id, null), 35 * 64 - 192);
  return { status: "succeeded", detail: JSON.stringify({ before, disposal, after }) };
};
