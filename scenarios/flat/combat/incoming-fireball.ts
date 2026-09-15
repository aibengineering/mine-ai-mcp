import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";
import { z } from "zod";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const runtime = await openRuntime(context, "incoming-fireball");
  const { navigating } = z
    .strictObject({ navigating: z.boolean().default(false) })
    .parse(context.scenario.params ?? {});
  const origin = bot.entity.position.clone();

  let approaching = false;
  let reflected = false;
  const observe = () => {
    const ball = Object.values(bot.entities).find((entity) => entity.name === "fireball" && entity.isValid);
    if (!ball) return;
    approaching ||= ball.velocity.x < -0.05;
    reflected ||= approaching && ball.velocity.x > 0.05;
  };
  bot.on("physicsTick", observe);
  try {
    // Scenario arrangement supplies a straight ghast-sized shot; production owns
    // detecting and answering it. The operator command never attacks for the bot.
    if (navigating) {
      const navigate = runtime.actions.find((action) => action.name === "navigate")!;
      let shot = false;
      const shoot = () => {
        if (shot || bot.entity.position.x < 2) return;
        shot = true;
        bot.chat("/summon minecraft:fireball 16.5 -52.5 0.5 {Motion:[-0.5d,0.0d,0.0d],ExplosionPower:1b}");
      };
      bot.on("physicsTick", shoot);
      try {
        const output = await runtime.run(navigate, { x: 16, y: -54, z: 0, range: 0 }, context.signal);
        const arrived = bot.entity.position.x >= 16 && Math.abs(bot.entity.position.z - 0.5) < 0.4;
        return {
          status: approaching && arrived && bot.health === 20 ? "succeeded" : "failed",
          detail: JSON.stringify({ approaching, reflected, arrived, health: bot.health, output }),
        };
      } finally {
        bot.off("physicsTick", shoot);
      }
    }
    bot.chat("/summon minecraft:fireball 12.5 -52.5 0.5 {Motion:[-0.5d,0.0d,0.0d],ExplosionPower:1b}");
    for (let tick = 0; tick < 100; tick += 1) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
      const ball = Object.values(bot.entities).find((entity) => entity.name === "fireball" && entity.isValid);
      if (bot.health < 20 || bot.entity.position.y < origin.y - 0.5) break;
      if (!ball && approaching) break;
    }
    const stayed = bot.entity.position.distanceTo(origin) < 0.5;
    return {
      status: approaching && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({
        approaching,
        reflected,
        stayed,
        health: bot.health,
        position: bot.entity.position,
      }),
    };
  } finally {
    bot.off("physicsTick", observe);
    await runtime.close();
  }
}
