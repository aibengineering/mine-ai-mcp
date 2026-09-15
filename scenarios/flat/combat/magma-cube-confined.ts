import type { BotEvents } from "mineflayer";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import { hurt, readEncounters, type Encounter } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  await wearArmor(context);
  if (!(await hurt(context, 11))) return { status: "failed", detail: "Could not arrange wounded health." };
  await bot.waitForTicks(12);
  let deaths = 0;
  let hitsWhileMoving = 0;
  const bystander = Object.values(bot.entities).find((entity) => entity.name === "enderman");
  let safeToolHits = 0;
  let bystanderHits = 0;
  let minimumHealth = bot.health;
  const health = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths += 1;
  };
  const hit: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.name === "magma_cube" && source?.id === bot.entity.id && bot.getControlState("forward")) {
      hitsWhileMoving += 1;
      if (
        bystander &&
        bystander.position.distanceTo(bot.entity.position) < 3.3 &&
        bot.heldItem?.name === "diamond_pickaxe"
      )
        safeToolHits += 1;
    }
    if (entity.id === bystander?.id && source?.id === bot.entity.id) bystanderHits += 1;
  };
  bot.on("death", death);
  bot.on("health", health);
  bot.on("entityHurt", hit);
  bot.chat("/execute as @e[type=minecraft:magma_cube] run data merge entity @s {NoAI:0b}");
  const runtime = await openRuntime(context, "magma-cube-confined");
  try {
    const encounters: Encounter[] = [];
    let encounter: Encounter | undefined;
    for (let tick = 0; tick < 340 && deaths === 0; tick += 5) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(5);
      const observed = await readEncounters(context, runtime);
      encounters.push(...observed);
      // Footing recovery can interrupt an escape. Observe its next response;
      // a real failure or completed separation still ends this fixture.
      encounter = observed.find((entry) => entry.outcome !== "cancelled");
    }
    const passed = deaths === 0 && bot.health > 0 && bystanderHits === 0;
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        deaths,
        hitsWhileMoving,
        safeToolHits,
        bystanderHits,
        minimumHealth,
        position: bot.entity.position,
        encounter,
        encounters,
      }),
    };
  } finally {
    await runtime.close();
    bot.off("death", death);
    bot.off("health", health);
    bot.off("entityHurt", hit);
  }
};
