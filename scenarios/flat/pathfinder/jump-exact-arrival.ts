import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal, log }) => {
  await bot.waitForChunksToLoad();
  const stop = navigation.onEvent((event) => {
    if (event.kind === "step_completed" || event.kind === "goal_arrived")
      log(JSON.stringify({ event, position: bot.entity.position, velocity: bot.entity.velocity }));
  });
  try {
    const output = await new ActionRunner().run(
      createNavigateAction(bot, navigation),
      {
        x: 5,
        y: -60,
        z: 2,
        range: 0,
        dig: false,
        scaffold: false,
      },
      signal,
    );
    await bot.waitForTicks(10);
    const cell = bot.entity.position.floored();
    return {
      status:
        output.result.status === "succeeded" && cell.x === 5 && cell.y === -60 && cell.z === 2 ? "succeeded" : "failed",
      detail: JSON.stringify({ output, positionAfterCoast: bot.entity.position }),
    };
  } finally {
    stop();
  }
};
