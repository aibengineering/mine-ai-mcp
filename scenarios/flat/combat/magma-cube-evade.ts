import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import { hurt, readEncounters, type Encounter } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  await wearArmor(context);
  if (!(await hurt(context, 11))) return { status: "failed", detail: "Could not arrange wounded health." };
  await bot.waitForTicks(12);
  const cubes = Object.values(bot.entities).filter((entity) => entity.name === "magma_cube");
  context.log(
    `Cubes: ${JSON.stringify(cubes.map((e) => ({ id: e.id, kind: e.kind, width: e.width, height: e.height, position: e.position })))}`,
  );
  if (cubes.length !== 2) return { status: "failed", detail: "Expected two arranged magma cubes." };
  let died = false;
  const initialHealth = bot.health;
  let minimumHealth = bot.health;
  let inLava = false;
  const death = () => {
    died = true;
  };
  const health = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const tick = () => {
    inLava ||= Reflect.get(bot.entity, "isInLava") === true;
  };
  bot.on("death", death);
  bot.on("health", health);
  bot.on("physicsTick", tick);
  bot.chat("/execute as @e[type=minecraft:magma_cube] run data merge entity @s {NoAI:0b}");
  const runtime = await openRuntime(context, "magma-cube-evade");
  const encounters: Encounter[] = [];
  try {
    // The response owns 15 seconds; allow its event to settle before judging it.
    for (let waited = 0; waited < 340 && !died; waited++) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
      if (waited % 5 === 0) encounters.push(...(await readEncounters(context, runtime)));
      if (encounters.length > 0) break;
    }
    const passed = !died && !inLava && minimumHealth === initialHealth && bot.health > 0;
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({ died, inLava, initialHealth, minimumHealth, position: bot.entity.position, encounters }),
    };
  } finally {
    await runtime.close();
    bot.off("death", death);
    bot.off("health", health);
    bot.off("physicsTick", tick);
  }
};
