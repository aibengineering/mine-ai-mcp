import { createBarterAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { z } from "zod";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal, log, scenario }) => {
  const params = z
    .object({
      item_name: z.string().default("blackstone"),
      gold_budget: z.number().default(1),
      interrupt: z.boolean().default(false),
    })
    .parse(scenario.params ?? {});
  const helmet = bot.inventory.items().find((item) => item.name === "golden_helmet");
  if (!helmet) throw new Error("Fixture helmet missing.");
  await bot.equip(helmet, "head");
  bot.chat("/random reset minecraft:gameplay/piglin_bartering 0 false false");
  await bot.waitForTicks(5);
  const target = bot.nearestEntity((entity) => entity.name === "piglin");
  if (!target && params.gold_budget > 0) throw new Error("Fixture piglin missing.");
  const drops: string[] = [];
  const observe = (entity: typeof bot.entity) => {
    const item = entity.getDroppedItem();
    if (item) drops.push(`${entity.id}:${item.name}:${item.count}`);
  };
  bot.on("itemDrop", observe);
  const runner = new ActionRunner();
  let interruptions = 0;
  const interrupt = (entity: typeof bot.entity) => {
    if (!params.interrupt || interruptions || entity.id !== target?.id || entity.equipment[1]?.name !== "gold_ingot")
      return;
    interruptions += 1;
    runner.claim("fixture_reflex", "observe exchange while foreground is yielded", async () => {
      await bot.waitForTicks(140);
      return { value: null, continuation: { kind: "resume" as const } };
    });
  };
  bot.on("entityEquip", interrupt);
  const goldCount = () =>
    bot.inventory
      .items()
      .filter((item) => item.name === "gold_ingot")
      .reduce((sum, item) => sum + item.count, 0);
  const goldBefore = goldCount();
  try {
    const receipt = await runner.run(
      createBarterAction(bot, navigation),
      { piglin_id: target?.id ?? 0, item_name: params.item_name, count: 1, gold_budget: params.gold_budget },
      signal,
    );
    const actualGoldSpent = goldBefore - goldCount();
    const validGold =
      "barter" in receipt.result &&
      actualGoldSpent === params.gold_budget &&
      receipt.result.barter.goldSpent === actualGoldSpent &&
      receipt.result.barter.goldOffers === params.gold_budget;
    const detail = JSON.stringify({
      actualGoldSpent,
      receipt,
      interruptions,
      drops,
      inventory: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
    });
    log(detail);
    return {
      status:
        receipt.result.status === "succeeded" && validGold && (!params.interrupt || interruptions === 1)
          ? "succeeded"
          : "failed",
      detail,
    };
  } finally {
    bot.off("itemDrop", observe);
    bot.off("entityEquip", interrupt);
  }
};
