/** Compare repeated same-cell pillar actuation with an independently observed tower. */
import type { ClientCompletion } from "mine-labs/client";
import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const TARGET = Object.freeze({ x: 0, y: -54, z: 0 });

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();

    const start = bot.entity.position.clone();
    const dirtId = bot.registry.itemsByName.dirt!.id;
    const dirtBefore = bot.inventory.count(dirtId, null);
    const unsupported = { x: 0, y: -58, z: 0 };
    const refused = await new ActionRunner().run(
      createNavigateAction(bot, context.navigation),
      { ...unsupported, range: 0, dig: true, scaffold: true },
      context.signal,
    );
    if (
      refused.result.status !== "failed" ||
      !refused.result.error.includes("NAVIGATION_TARGET_UNSUPPORTED") ||
      !refused.result.error.includes("ground in that column is at y=-59") ||
      !("navigation" in refused.result) ||
      refused.result.navigation.target.y !== unsupported.y ||
      bot.entity.position.distanceTo(start) > 0.01 ||
      bot.inventory.count(dirtId, null) !== dirtBefore
    ) {
      return {
        status: "failed",
        detail: `Unsupported adjacent height was not honestly refused: ${JSON.stringify(refused.result)}`,
      };
    }
    context.log("Unsupported adjacent height refused with requested Y, unchanged position and scaffold inventory.");

    const startedAt = Date.now();
    const run = await new ActionRunner().run(
      createNavigateAction(bot, context.navigation),
      { ...TARGET, range: 0.5, build: true },
      context.signal,
    );
    const cell = bot.entity.position.floored();
    const reached = cell.x === TARGET.x && cell.y === TARGET.y && cell.z === TARGET.z;
    const detail =
      `${run.result.status} in ${Date.now() - startedAt} ms at ${cell.x},${cell.y},${cell.z}; ` +
      context.pathfinder.summary();
    const failureDetail = run.result.status === "succeeded" ? "target cell was not observed" : run.result.error;
    context.log(detail);
    return run.result.status === "succeeded" && reached
      ? { status: "succeeded", detail }
      : { status: "failed", detail: `${detail}; ${failureDetail}` };
  } catch (cause) {
    return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
