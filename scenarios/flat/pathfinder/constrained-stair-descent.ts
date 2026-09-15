import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  await standStill(context);
  let drop = false;
  let takeoffY = 0;
  let stoppedOnLip = 0;
  let dropTicks = 0;
  const observe = () => {
    if (!drop) return;
    dropTicks += 1;
    if (bot.entity.onGround && bot.entity.position.y >= takeoffY && !bot.getControlState("forward")) stoppedOnLip += 1;
  };
  const stop = navigation.onEvent((event) => {
    if (event.kind === "step_started") {
      drop = event.movement === "drop";
      takeoffY = bot.entity.position.y;
    }
    if (event.kind === "step_started" || event.kind === "step_completed")
      log(JSON.stringify({ event, position: bot.entity.position }));
  });
  bot.on("physicsTick", observe);
  try {
    const result = await new ActionRunner().run(
      createNavigateAction(bot, navigation),
      {
        x: 0,
        y: -60,
        z: -8,
        range: 0,
        dig: false,
        scaffold: false,
      },
      signal,
    );
    return {
      status: result.result.status === "succeeded" ? "succeeded" : "failed",
      detail: JSON.stringify({ result, dropTicks, stoppedOnLip, position: bot.entity.position }),
    };
  } finally {
    bot.off("physicsTick", observe);
    stop();
  }
};
