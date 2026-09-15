import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const runtime = await openRuntime(context, "ghast-return-to-sender");
  const origin = bot.entity.position.clone();

  let ghastDied = false;
  let reflected = false;
  const died = (entity: Parameters<typeof bot.attack>[0]) => {
    if (entity.name === "ghast") ghastDied = true;
  };
  bot.on("entityDead", died);
  try {
    for (let tick = 0; tick < 600; tick += 1) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
      const ball = Object.values(bot.entities).find((entity) => entity.name === "fireball" && entity.isValid);
      if (ball) {
        reflected ||= ball.velocity.x > 0;
      }
      if (ghastDied || bot.health < 20 || bot.entity.position.y < origin.y - 0.5) break;
    }
    const stayed = bot.entity.position.distanceTo(origin) < 0.5;
    return {
      status: ghastDied && reflected && stayed && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ ghastDied, reflected, stayed, health: bot.health }),
    };
  } finally {
    bot.off("entityDead", died);
    await runtime.close();
  }
}
