import type { MineAiScenario } from "../../src/scenario-client.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";

export const run: MineAiScenario = async ({ bot, log, signal }) => {
  log(JSON.stringify({ physics: bot.physics }));
  let last = bot.entity.position.clone();
  const sample = async (phase: string, ticks: number, controls: () => void) => {
    for (let tick = 0; tick < ticks; tick++) {
      signal.throwIfAborted();
      controls();
      await bot.waitForTicks(1);
      log(JSON.stringify({ phase, tick, position: bot.entity.position, delta: bot.entity.position.minus(last),
        velocity: bot.entity.velocity, air: airSupplyTicks(bot), ground: bot.entity.onGround,
        collision: Reflect.get(bot.entity, "isCollidedHorizontally"), jump: bot.getControlState("jump") }));
      last = bot.entity.position.clone();
    }
  };
  try {
    await sample("sink", 40, () => bot.setControlState("jump", false));
    const depth = bot.entity.position.y;
    await sample("hold", 40, () => bot.setControlState("jump", bot.entity.position.y + bot.entity.velocity.y * 4 < depth));
    await bot.look(-Math.PI / 2, 0, true);
    await sample("wall", 50, () => {
      bot.setControlState("forward", true);
      bot.setControlState("jump", false);
    });
    bot.setControlState("forward", false);
    await sample("rise", 80, () => bot.setControlState("jump", true));
    return { status: "succeeded", detail: "Recorded controls and physical displacement; no navigation requested." };
  } finally { bot.clearControlStates(); }
};
