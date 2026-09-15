import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { declaredEntitiesArranged, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "../../src/scenario-client.ts";
import { hurt } from "./reflex.ts";

/** Arrange injury and hunger before the ordinary runtime receives the journey. */
export const prepare: MineAiScenarioPreparation = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("The return journey start did not settle.");
  await wearArmor(context);
  const shield = bot.inventory.items().find(item => item.name === "shield")!;
  await bot.equip(shield, "off-hand");
  if (!(await hurt(context, 9))) throw new Error("Could not arrange the wounded start.");
  bot.chat("/effect give @s minecraft:hunger 2 255 true");
  for (let tick = 0; tick < 100 && bot.food >= 18; tick++) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  bot.chat("/effect clear @s minecraft:hunger");
  await bot.waitForTicks(2);
  if (bot.food >= 18 || bot.health > 10) throw new Error("Wounded, hungry starting conditions were not observed.");
};

/** Bring the carried iron home. Fighting, eating, shelter and detours are all permitted. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await declaredEntitiesArranged(context);
  const starting = { health: bot.health, food: bot.food };
  const destination = new Vec3(30.5, -60, 0.5);
  const died = new AbortController();
  const death = () => died.abort("Died while bringing supplies home.");
  bot.on("death", death);
  const runtime = await openRuntime(context, "wounded-supply-return");
  try {
    bot.chat("/gamerule naturalRegeneration true");
    const output = await runtime.run(runtime.actions.find(action => action.name === NAVIGATE)!,
      { x: 30, y: -60, z: 0, range: 1 }, AbortSignal.any([signal, died.signal]));
    const arrived = bot.entity.position.distanceTo(destination) <= 2;
    const iron = bot.inventory.items().filter(item => item.name === "iron_ingot").reduce((sum, item) => sum + item.count, 0);
    return {
      status: arrived && iron >= 8 && bot.health > 0 && !died.signal.aborted ? "succeeded" : "failed",
      detail: JSON.stringify({ starting, arrived, iron, health: bot.health, died: died.signal.aborted, output }),
    };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
};
