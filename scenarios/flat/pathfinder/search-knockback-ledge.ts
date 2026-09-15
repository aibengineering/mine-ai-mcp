import { MineflayerBot, mineflayerBotSurface } from "../../../src/navigation/mineflayer/bot.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { standStill } from "../../src/runtime.ts";

/** Isolate the real search hold against the recorded impulse using live player physics. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  if (!(await standStill(context))) throw new Error("Search ledge did not settle");
  const actuator = new MineflayerBot(mineflayerBotSurface(bot), navigation.world);
  const release = actuator.holdPosition(navigation.world);
  let lava = false;
  let lowestY = bot.entity.position.y;
  const observe = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    lowestY = Math.min(lowestY, bot.entity.position.y);
  };
  bot.on("physicsTick", observe);
  try {
    // Exact server entity_velocity from the 2026-09-08 EyesBot death.
    // The impulse is injected; collision, air control and landing are live physics.
    bot.entity.velocity.set(0.167125, 0.275125, -0.13725);
    await bot.waitForTicks(30);
    return {
      status: bot.entity.onGround && lowestY >= -56 && !lava && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({
        lowestY,
        lava,
        health: bot.health,
        grounded: bot.entity.onGround,
        position: bot.entity.position,
      }),
    };
  } finally {
    bot.off("physicsTick", observe);
    release();
  }
};
