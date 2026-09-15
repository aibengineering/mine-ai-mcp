import { run as hunt } from "../../src/hunter.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";

export const prepare: MineAiScenarioPreparation = async ({ bot }) => {
  bot.chat('/item replace entity @s weapon.offhand with minecraft:shield[minecraft:damage=335]');
  for (let tick = 0; tick < 40; tick++) {
    if (bot.inventory.slots[45]?.durabilityUsed === 335) return;
    await bot.waitForTicks(1);
  }
  throw new Error("Worn starting shield was not observed in the off-hand.");
};

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  let broken = false, replaced = false, blockingAgain = false;
  const observe = () => {
    const shield = bot.inventory.slots[45];
    if (!shield) broken = true;
    if (broken && shield?.name === "shield" && shield.durabilityUsed < 335) replaced = true;
    if (replaced && bot.usingHeldItem) blockingAgain = true;
  };
  bot.on("physicsTick", observe);
  bot.inventory.on("updateSlot", observe);
  try {
    const outcome = await hunt(context);
    return { status: outcome.status === "succeeded" && broken && replaced && blockingAgain ? "succeeded" : "failed",
      detail: JSON.stringify({ broken, replaced, blockingAgain, hunt: outcome }) };
  } finally {
    bot.off("physicsTick", observe);
    bot.inventory.off("updateSlot", observe);
  }
};
