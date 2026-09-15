import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { Vec3 } from "vec3";

export const run: MineAiScenario = async (context) => {
  await context.bot.waitForChunksToLoad();
  const runner = new ActionRunner();
  const result = await runner.run(
    createNavigateAction(context.bot, context.navigation),
    {
      x: -1,
      y: -60,
      z: 0,
      range: 0,
      dig: false,
      scaffold: false,
    },
    context.signal,
  );
  const closed = [-60, -59].every((y) => context.bot.blockAt(new Vec3(0, y, 0))?.getProperties().open === false);
  return {
    status: result.result.status === "succeeded" && closed ? "succeeded" : "failed",
    detail: JSON.stringify({ result: result.result, closed }),
  };
};
