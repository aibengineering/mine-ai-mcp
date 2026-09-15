import { craftItem } from "../../../src/actions/craft-item/craft-item.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ navigation, bot, signal, log }) => {
  const evidence: string[] = [];
  let passed = true;
  for (const testCase of ["full", "free-slot", "consumed-slot"] as const) {
    bot.chat("/clear @s");
    bot.chat("/kill @e[type=minecraft:item]");
    bot.chat(`/give @s minecraft:cobblestone ${testCase === "free-slot" ? 2176 : 2240}`);
    bot.chat(`/give @s minecraft:oak_log ${testCase === "consumed-slot" ? 1 : 2}`);
    await bot.waitForTicks(15);
    const count = (name: string) =>
      bot.inventory
        .items()
        .filter((item) => item.name === name)
        .reduce((total, item) => total + item.count, 0);
    const slotsBefore = bot.inventory.items().length;
    const dropped = new Map<number, { name: string; count: number }>();
    const observeDrop: Parameters<typeof bot.on<"itemDrop">>[1] = (entity) => {
      const item = entity.getDroppedItem();
      if (item) dropped.set(entity.id, { name: item.name, count: item.count });
    };
    bot.on("itemDrop", observeDrop);
    try {
      const result = await craftItem(
        bot,
        navigation,
        {
          items: [
            {
              itemName: testCase === "consumed-slot" ? "oak_planks" : "chest",
              count: testCase === "consumed-slot" ? 4 : 1,
            },
          ],
        },
        { signal },
      );
      await bot.waitForTicks(10);
      const observed = {
        testCase,
        slotsBefore,
        logs: count("oak_log"),
        planks: count("oak_planks"),
        chests: count("chest"),
        dropped: [...dropped.values()],
        result,
      };
      const noOutputDropped = observed.dropped.every((item) => item.name !== "oak_planks" && item.name !== "chest");
      const outcomeMatches =
        testCase === "full"
          ? result.status === "failed" &&
            JSON.stringify(result).includes("execution needs inventory room") &&
            observed.logs === 2 &&
            observed.planks === 0 &&
            observed.chests === 0 &&
            slotsBefore === 36
          : result.status === "succeeded" &&
            observed.logs === 0 &&
            (testCase === "free-slot"
              ? observed.chests === 1 && slotsBefore === 35
              : observed.planks === 4 && slotsBefore === 36);
      passed &&= noOutputDropped && outcomeMatches;
      evidence.push(JSON.stringify(observed));
      log(JSON.stringify(observed));
    } finally {
      bot.off("itemDrop", observeDrop);
    }
  }
  return { status: passed ? "succeeded" : "failed", detail: JSON.stringify(evidence) };
};
