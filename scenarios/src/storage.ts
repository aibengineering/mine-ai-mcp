/** Exercise both item directions and organization, then compare SQLite memory with a fresh observation. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  ActionRunner,
  createUseContainerAction,
  SqlBotData,
} from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";

import type { MineAiScenarioContext } from "./scenario-client.ts";

const paramsSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  using data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "chest-round-trip", scope: { kind: "bot", botId: bot.username } },
  });

  context.signal.throwIfAborted();
  const position = paramsSchema.parse(context.scenario.params);
  const runner = new ActionRunner();
  const action = createUseContainerAction(bot, context.navigation, data);

  const organized = await runner.run(
    action,
    {
      operation: "organize",
      ...position,
      item_order: ["oak_log", "cobblestone"],
    },
    context.signal,
  );
  if (organized.result.status !== "succeeded") {
    throw new Error("error" in organized.result ? organized.result.error : "organize did not succeed");
  }

  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block) throw new Error("chest block was not loaded for independent inspection");
  const organizedWindow = await bot.openContainer(block);
  const physicalOrganizedSlots = organizedWindow
    .containerItems()
    .map(({ slot, name: item_name, count: item_count }) => ({ slot, item_name, item_count }))
    .sort((left, right) => left.slot - right.slot);
  organizedWindow.close();
  const rememberedOrganizedSlots = data.read(
    "SELECT slot, item_name, item_count FROM observed_container_slots ORDER BY slot",
  );
  const expectedOrganizedSlots = [
    { slot: 0, item_name: "oak_log", item_count: 2 },
    { slot: 1, item_name: "cobblestone", item_count: 64 },
    { slot: 2, item_name: "cobblestone", item_count: 6 },
  ];
  if (
    JSON.stringify(physicalOrganizedSlots) !== JSON.stringify(expectedOrganizedSlots) ||
    JSON.stringify(rememberedOrganizedSlots) !== JSON.stringify(expectedOrganizedSlots)
  ) {
    throw new Error(
      `expected physical and remembered organized slots ${JSON.stringify(expectedOrganizedSlots)}; observed ` +
        `${JSON.stringify(physicalOrganizedSlots)}/${JSON.stringify(rememberedOrganizedSlots)}`,
    );
  }

  const deposited = await runner.run(
    action,
    { operation: "deposit", ...position, items: [{ item_name: "cobblestone", count: 1 }] },
    context.signal,
  );
  if (deposited.result.status !== "succeeded") {
    throw new Error("error" in deposited.result ? deposited.result.error : "deposit did not succeed");
  }
  const expectedDepositedSlots = [
    { slot: 0, item: "oak_log", count: 2 },
    { slot: 1, item: "cobblestone", count: 64 },
    { slot: 2, item: "cobblestone", count: 7 },
  ];
  if (JSON.stringify(deposited.result.container.contents) !== JSON.stringify(expectedDepositedSlots)) {
    throw new Error(
      `expected deposit to fill the existing partial stack ${JSON.stringify(expectedDepositedSlots)}; observed ` +
        JSON.stringify(deposited.result.container.contents),
    );
  }

  const withdrawn = await runner.run(
    action,
    { operation: "withdraw", ...position, items: [{ item_name: "cobblestone", count: 3 }] },
    context.signal,
  );
  if (withdrawn.result.status !== "succeeded") {
    throw new Error("error" in withdrawn.result ? withdrawn.result.error : "withdraw did not succeed");
  }

  const finalWindow = await bot.openContainer(block);
  const physicalCount = finalWindow
    .containerItems()
    .reduce((count, item) => count + (item.name === "cobblestone" ? item.count : 0), 0);
  const physicalFinalSlots = finalWindow
    .containerItems()
    .map(({ slot, name: item_name, count: item_count }) => ({ slot, item_name, item_count }))
    .sort((left, right) => left.slot - right.slot);
  finalWindow.close();
  const rememberedCount = data.read(
    "SELECT item_count FROM observed_container_items WHERE item_name = 'cobblestone'",
  )[0]?.item_count;
  const rememberedFinalSlots = data.read(
    "SELECT slot, item_name, item_count FROM observed_container_slots ORDER BY slot",
  );
  const physicalCobblestoneStacks = physicalFinalSlots.filter(({ item_name }) => item_name === "cobblestone");
  const physicalCobblestoneSlots = physicalCobblestoneStacks
    .map(({ slot }) => slot)
    .sort((left, right) => left - right);
  const physicalCobblestoneCounts = physicalCobblestoneStacks
    .map(({ item_count }) => item_count)
    .sort((left, right) => left - right);
  if (
    physicalCount !== 68 ||
    rememberedCount !== 68 ||
    JSON.stringify(physicalFinalSlots) !== JSON.stringify(rememberedFinalSlots) ||
    JSON.stringify(physicalCobblestoneSlots) !== JSON.stringify([1, 2]) ||
    JSON.stringify(physicalCobblestoneCounts) !== JSON.stringify([4, 64])
  ) {
    throw new Error(
      `expected physical and remembered cobblestone x68 compacted into slots 1 and 2 as counts 64 and 4; ` +
        `observed totals ` +
        `${physicalCount}/${String(rememberedCount)} and layouts ` +
        `${JSON.stringify(physicalFinalSlots)}/${JSON.stringify(rememberedFinalSlots)}`,
    );
  }
  return {
    status: "succeeded",
    detail: "bulk deposit, withdrawal, compact item ordering, physical chest, and SQLite slot memory agree",
  };
}
