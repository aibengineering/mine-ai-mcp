import { createBarterAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import type { BotEvents } from "mineflayer";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** A nonrequested native reward must remain observed while a reflex owns the body. */
export const run: MineAiScenario = async ({ bot, navigation, signal, log }) => {
  await bot.equip(
    bot.inventory.items().find((item) => item.name === "golden_helmet")!,
    "head",
  );
  bot.chat("/random reset minecraft:gameplay/piglin_bartering 0 false false");
  await bot.waitForTicks(5);
  const target = bot.nearestEntity((entity) => entity.name === "piglin");
  if (!target) return { status: "failed", detail: "Arranged piglin was not loaded." };
  const runner = new ActionRunner();
  const count = (name: string) =>
    bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((sum, item) => sum + item.count, 0);
  const goldBefore = count("gold_ingot");
  let takeover: Promise<unknown> | null = null;
  let rewardDuringTakeover = false;
  let spawnedDuringTakeover = false;
  let groundEmptyAtRelease = false;
  const onDrop: BotEvents["itemDrop"] = (item) => {
    if (item.getDroppedItem()?.name === "blackstone" && runner.status().owner === "takeover") {
      spawnedDuringTakeover = true;
    }
  };
  const onEquip: BotEvents["entityEquip"] = (entity) => {
    if (entity.id !== target.id || takeover || entity.equipment[1]?.name !== "gold_ingot") return;
    takeover = (async () => {
      await bot.waitForTicks(2);
      const claim = runner.claim("fixture_reflex", "Hold through incidental reward pickup", async (stop) => {
        while (count("blackstone") === 0) {
          stop.throwIfAborted();
          signal.throwIfAborted();
          await bot.waitForTicks(1);
        }
        rewardDuringTakeover = runner.status().owner === "takeover";
        await bot.waitForTicks(5);
        groundEmptyAtRelease = !Object.values(bot.entities).some(
          (item) => item.getDroppedItem()?.name === "blackstone",
        );
        log(
          JSON.stringify({
            owner: runner.status().owner,
            blackstone: count("blackstone"),
            groundEmptyAtRelease,
            spawnedDuringTakeover,
          }),
        );
        return { value: null, continuation: { kind: "resume" as const } };
      });
      if (claim.kind === "claimed") await claim.outcome;
    })();
  };
  bot.on("entityEquip", onEquip);
  bot.on("itemDrop", onDrop);
  try {
    const receipt = await runner.run(
      createBarterAction(bot, navigation),
      { piglin_id: target.id, item_name: "ender_pearl", count: 1, gold_budget: 2 },
      signal,
    );
    await takeover;
    const passed =
      rewardDuringTakeover &&
      spawnedDuringTakeover &&
      groundEmptyAtRelease &&
      "barter" in receipt.result &&
      receipt.result.barter.goldOffers === 2 &&
      receipt.result.barter.goldSpent === 2 &&
      count("gold_ingot") === goldBefore - 2;
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        rewardDuringTakeover,
        spawnedDuringTakeover,
        groundEmptyAtRelease,
        goldBefore,
        goldAfter: count("gold_ingot"),
        receipt,
      }),
    };
  } finally {
    bot.off("entityEquip", onEquip);
    bot.off("itemDrop", onDrop);
  }
};
