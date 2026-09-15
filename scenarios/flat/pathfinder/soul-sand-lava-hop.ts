import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Use navigation alone so a successful fire escape cannot hide a failed crossing. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  if (!(await standStill(context))) throw new Error("Soul-sand start did not settle.");
  let minimumHealth = bot.health;
  const failures: string[] = [];
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    log(
      JSON.stringify({
        position: bot.entity.position,
        velocity: bot.entity.velocity,
        health: bot.health,
        jump: bot.controlState.jump,
        ground: bot.entity.onGround,
      }),
    );
  };
  const release = navigation.onEvent((event) => {
    if (event.kind === "step_failed") failures.push(event.observation);
    if (event.kind === "step_started" || event.kind === "step_failed")
      log(JSON.stringify({ event, position: bot.entity.position, controls: bot.controlState }));
  });
  bot.on("physicsTick", tick);
  try {
    const output = await new ActionRunner().run(
      createNavigateAction(bot, navigation),
      { x: 3, y: -60, z: 0, range: 0, dig: false, scaffold: false },
      signal,
    );
    await bot.waitForTicks(25);
    return {
      status:
        output.result.status === "succeeded" &&
        minimumHealth === 20 &&
        bot.entity.onGround &&
        bot.entity.position.x >= 3 &&
        bot.entity.position.y > -60.2
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ output: output.result, minimumHealth, position: bot.entity.position, failures }),
    };
  } finally {
    release();
    bot.off("physicsTick", tick);
  }
};
