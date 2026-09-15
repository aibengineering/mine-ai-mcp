/** Prove a policy-default scaffold material through production navigate and independently observed blocks. */
import type { ClientCompletion } from "mine-labs/client";
import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import { z } from "zod";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";

const paramsSchema = z.strictObject({ material: z.enum(["cobbled_deepslate", "end_stone"]) });
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  try {
    await bot.waitForChunksToLoad();
    const { material } = paramsSchema.parse(context.scenario.params);
    // Register the real default policy provider used by every scaffold consumer.
    new SurvivalPolicyState(bot);
    const target = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y) + 5, z: Math.floor(bot.entity.position.z) };
    const itemId = bot.registry.itemsByName[material]!.id;
    const before = bot.inventory.count(itemId, null);
    const output = await new ActionRunner().run(
      createNavigateAction(bot, context.navigation),
      { ...target, range: 0.5, build: true },
      context.signal,
    );
    const feet = bot.entity.position.floored();
    const after = bot.inventory.count(itemId, null);
    const placed = before - after;
    const column = Array.from({ length: 5 }, (_, index) => bot.blockAt(feet.offset(0, -1 - index, 0))?.name);
    const detail = JSON.stringify({ status: output.result.status, material, before, after, placed, feet, column });
    context.log(detail);
    return output.result.status === "succeeded" && placed === 5 && column.every((name) => name === material)
      ? { status: "succeeded", detail }
      : { status: "failed", detail };
  } catch (cause) {
    return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
