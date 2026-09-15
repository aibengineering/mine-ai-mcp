import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

async function command(bot: Parameters<MineAiScenario>[0]["bot"], value: string): Promise<void> {
  bot.chat(value);
  await bot.waitForTicks(4);
}

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await bot.waitForChunksToLoad();
  await using runtime = await openRuntime(context, "tool-loss-policy");
  const collect = runtime.actions.find((action) => action.name === "collect_block")!;
  const cases: Record<string, unknown> = {};

  const prepare = async (backup: boolean) => {
    await command(bot, "/kill @e[type=minecraft:item]");
    await command(bot, "/clear @s");
    await command(bot, "/tp @s 0.5 -60 0.5");
    await command(bot, "/fill 2 -60 0 4 -60 0 stone");
    await command(bot, "/item replace entity @s weapon.mainhand with diamond_pickaxe[minecraft:damage=1560]");
    if (backup) await command(bot, "/give @s stone_pickaxe 1");
    const diamond = bot.inventory.count(bot.registry.itemsByName.diamond_pickaxe!.id, null);
    const stone = bot.inventory.count(bot.registry.itemsByName.stone_pickaxe!.id, null);
    if (bot.heldItem?.name !== "diamond_pickaxe" || diamond !== 1 || stone !== (backup ? 1 : 0)) {
      throw new Error(`fixture inventory mismatch: held=${bot.heldItem?.name ?? "empty"}, diamond=${diamond}, stone=${stone}`);
    }
    return { held: bot.heldItem.name, diamond, stone };
  };

  const settlement = (label: string) => {
    if (!bot.entity.onGround) throw new Error(`${label} settled airborne at ${bot.entity.position}`);
    return { grounded: true, position: bot.entity.position.toString(),
      diamond: bot.inventory.count(bot.registry.itemsByName.diamond_pickaxe!.id, null),
      stone: bot.inventory.count(bot.registry.itemsByName.stone_pickaxe!.id, null) };
  };

  const stoppedBefore = await prepare(true);
  const stopped = await runtime.run(collect, { block_name: "stone", count: 3 }, signal);
  cases.stopped = { before: stoppedBefore, result: stopped.result, settled: settlement("default stop") };
  if (stopped.result.status === "succeeded" || !(stopped.result.error ?? "").includes("TOOL_TIER_LOST"))
    return { status: "failed", detail: `default stop did not preserve tool-loss evidence: ${JSON.stringify(cases)}` };

  const continuedBefore = await prepare(true);
  const continued = await runtime.run(collect, { block_name: "stone", count: 3, on_tool_loss: "continue" }, signal);
  cases.continued = { before: continuedBefore, result: continued.result, settled: settlement("continue") };
  if (continued.result.status !== "succeeded")
    return { status: "failed", detail: `continue did not finish with the remaining pickaxe: ${JSON.stringify(cases)}` };

  const lastToolBefore = await prepare(false);
  const lastTool = await runtime.run(collect, { block_name: "stone", count: 3 }, signal);
  cases.lastTool = { before: lastToolBefore, result: lastTool.result, settled: settlement("last-tool stop") };
  if (lastTool.result.status === "succeeded" || !(lastTool.result.error ?? "").includes("TOOL_TIER_LOST"))
    return { status: "failed", detail: `last-tool loss was not explicit: ${JSON.stringify(cases)}` };

  return { status: "succeeded", detail: JSON.stringify(cases) };
};
