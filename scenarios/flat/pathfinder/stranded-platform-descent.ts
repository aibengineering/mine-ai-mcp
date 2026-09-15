import { z } from "zod";
import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  target: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  range: z.number().nonnegative(),
});

/** An unsupported descent must settle as a refusal while leaving the body safe. */
export const run: MineAiScenario = async ({ bot, navigation, scenario, signal }) => {
  await bot.waitForChunksToLoad();
  const {
    target: [x, y, z],
    range,
  } = paramsSchema.parse(scenario.params);
  const startingY = bot.entity.position.y;
  const output = await new ActionRunner().run(
    createNavigateAction(bot, navigation),
    { x, y, z, range },
    signal,
  );
  const result = output.result;
  const stopped = result.status === "failed" && result.error.startsWith("[NAVIGATION_STOPPED]");
  const outsideTarget =
    "navigation" in result &&
    result.navigation.remainingDistance !== null &&
    result.navigation.remainingDistance > range;
  const safelyAbove = bot.entity.onGround && bot.entity.position.y >= startingY;
  return {
    status: stopped && outsideTarget && safelyAbove && bot.health === 20 ? "succeeded" : "failed",
    detail: JSON.stringify({
      expected: "unsupported descent stops without reaching the ground",
      stopped,
      outsideTarget,
      safelyAbove,
      health: bot.health,
      output,
    }),
  };
};
