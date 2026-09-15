import { ActionRunner, createCollectBlockAction } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function prepare({ bot, log }: MineAiScenarioContext): Promise<void> {
  const tip = bot.blockAt(new Vec3(0, -58, 0));
  log(`TIP_BEFORE ${JSON.stringify({ name: tip?.name, properties: tip?.getProperties(), shapes: tip?.shapes })}`);
  if (tip?.name !== "pointed_dripstone" || tip.getProperties().vertical_direction !== "up" || tip.shapes.length === 0)
    throw new Error("Supported upward dripstone tip was not observed before collection.");
  const target = new Vec3(0.5, -57, 0.5);
  const moved = new Promise<void>((resolve, reject) => {
    let ticks = 0;
    const observe = () => {
      log(`TIP_PHYSICS ${JSON.stringify({ position: bot.entity.position, velocityY: bot.entity.velocity.y, onGround: bot.entity.onGround })}`);
      if (bot.entity.position.distanceTo(target) <= 0.1) { bot.off("physicsTick", observe); resolve(); }
      else if (++ticks >= 40) { bot.off("physicsTick", observe); reject(new Error(`Teleport not observed at ${bot.entity.position}.`)); }
    };
    bot.on("physicsTick", observe);
  });
  bot.chat("/tp @s 0.5 -57 0.5");
  await moved;
  await bot.waitForTicks(5);
  if (!bot.entity.onGround || bot.blockAt(bot.entity.position.floored())?.name !== "pointed_dripstone")
    throw new Error(`Supported tip did not ground the collector at ${bot.entity.position}.`);
}

export const run: MineAiScenario = async (context) => {
  const result = await new ActionRunner().run(
    createCollectBlockAction(context.bot, context.navigation),
    { block_name: "stone", count: 1, x: 1, y: -58, z: 0, scaffold: false },
    context.signal,
  );
  const target = context.bot.blockAt(new Vec3(1, -58, 0));
  return {
    status: result.result.status === "succeeded" ? "succeeded" : "failed",
    detail: JSON.stringify({ result, finalPosition: context.bot.entity.position, onGround: context.bot.entity.onGround, target: target?.name, health: context.bot.health, navigation: context.pathfinder.summary() }),
  };
};
