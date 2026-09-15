import { isBurning } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Pin the recorded edge overlap; ordinary runtime reflexes own all escape controls. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("Soul-sand start did not settle.");
  await using runtime = await openRuntime(context, "soul-sand-lava-contact");
  let sawEdge = false;
  let sawFalseSwimmingFlag = false;
  let sawFireOwner = false;
  let died = false;
  const death = () => {
    died = true;
  };
  const observe = () => {
    if (bot.entity.position.x > 0.7 && bot.entity.position.x < 1) {
      sawEdge = true;
      sawFalseSwimmingFlag ||= Reflect.get(bot.entity, "isInLava") === false;
    }
    sawFireOwner ||= runtime.status().activeAction?.action === "fire_reflex";
  };
  // Observe the teleport packet as well as physics. The reflex can leave the
  // overlap before an awaiting driver's next continuation gets to sample it.
  bot.on("move", observe);
  bot.on("physicsTick", observe);
  bot.on("death", death);
  try {
    bot.chat("/tp @s 0.761841334797 -60.125 0.5");
    // Lava leaves a long burn after exit. Keep observing through that damage,
    // rather than passing as soon as the body has moved one cell.
    for (let tick = 0; tick < 340 && !died; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    return {
      status:
        sawEdge && sawFalseSwimmingFlag && !died && !isBurning(bot) && bot.health > 0 && bot.entity.position.x < 0.7
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        sawEdge,
        sawFalseSwimmingFlag,
        sawFireOwner,
        died,
        health: bot.health,
        burning: isBurning(bot),
        position: bot.entity.position,
      }),
    };
  } finally {
    bot.off("move", observe);
    bot.off("physicsTick", observe);
    bot.off("death", death);
  }
};
