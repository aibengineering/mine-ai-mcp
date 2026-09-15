import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";

/** Item components are not supported by the scenario inventory schema. */
export const prepare: MineAiScenarioPreparation = async (context) => {
  const { bot, signal } = context;
  bot.chat(`/item replace entity ${bot.username} weapon.offhand with shield[damage=319]`);
  bot.chat(`/item replace entity ${bot.username} inventory.0 with shield`);
  while (bot.inventory.slots[45]?.durabilityUsed !== 319 || bot.inventory.slots[9]?.name !== "shield") {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
};

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await bot.waitForChunksToLoad();
  const source = bot.inventory.items().find((item) => item.name === "shield" && item.durabilityUsed === 0)!;
  await using runtime = await openRuntime(context, "equip-selected-shield");
  const action = runtime.actions.find((a) => a.name === "equip")!;
  const result = await runtime.run(action, { items: [{ item_name: "shield", source_slot: source.slot }] }, signal);
  // Allow server inventory reconciliation before judging the resulting equipment.
  await bot.waitForTicks(3);
  const shield = bot.inventory.slots[45];
  const correct = result.result.status === "succeeded" && shield?.name === "shield" && shield.durabilityUsed === 0
    && bot.heldItem?.name === "diamond_sword" && bot.inventory.slots[9]?.durabilityUsed === 319;
  return { status: correct ? "succeeded" : "failed", detail: JSON.stringify({ durabilityUsed: shield?.durabilityUsed, result }) };
};
