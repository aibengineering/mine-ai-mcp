import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const count = (name: string) => bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
  await bot.waitForChunksToLoad();
  bot.chat("/kill @e[type=minecraft:item]");
  await bot.waitForTicks(4);
  bot.chat("/clear @s");
  await bot.waitForTicks(4);
  bot.chat("/item replace entity @s weapon.mainhand with diamond_pickaxe[minecraft:damage=1556]");
  for (let tick = 0; tick < 40 && bot.heldItem?.name !== "diamond_pickaxe"; tick++) await bot.waitForTicks(1);
  bot.chat("/give @s stone_pickaxe 1");
  for (let tick = 0; tick < 40 && count("stone_pickaxe") !== 1; tick++) await bot.waitForTicks(1);
  const before = { held: bot.heldItem?.name ?? null,
    diamond: count("diamond_pickaxe"), stone: count("stone_pickaxe") };
  if (before.held !== "diamond_pickaxe" || before.diamond !== 1 || before.stone !== 1)
    return { status: "failed", detail: `fixture inventory mismatch: ${JSON.stringify(before)}` };
  const runner = new ActionRunner();
  const action = createNavigateAction(bot, context.navigation);
  const request = { x: 12, y: -60, z: 0, range: 1, dig: true };
  const first = await runner.run(action, request, context.signal);
  context.log(`first navigation: ${JSON.stringify(first.result)}`);
  if (!bot.entity.onGround) return { status: "failed", detail: `first navigation settled airborne at ${bot.entity.position}` };
  if (first.result.status !== "partial" || !("error" in first.result) || !first.result.error.includes("TOOL_TIER_LOST")) {
    return { status: "failed", detail: `first route did not report tool loss: ${JSON.stringify(first.result)}` };
  }
  const second = await runner.run(action, request, context.signal);
  context.log(`second navigation: ${JSON.stringify(second.result)}`);
  // Mineflayer may resolve equip before the final server slot reconciliation;
  // retain the post-settlement count only after those packets have landed.
  await bot.waitForTicks(5);
  const after = { grounded: bot.entity.onGround, position: bot.entity.position.toString(),
    diamond: count("diamond_pickaxe"), stone: count("stone_pickaxe") };
  return second.result.status === "succeeded" && after.grounded && after.diamond === 0 && after.stone === 1
    ? { status: "succeeded", detail: JSON.stringify({ before, first: first.result, second: second.result, after }) }
    : { status: "failed", detail: `resume failed: ${JSON.stringify({ second: second.result, after })}` };
}
