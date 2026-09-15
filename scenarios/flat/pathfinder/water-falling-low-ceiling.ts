import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as traverseWater } from "./water-traversal.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const column = bot.blockAt(new Vec3(0, -59, 0));
  const head = bot.blockAt(new Vec3(0, -58, 0));
  const ceiling = bot.blockAt(new Vec3(-1, -57, 0));
  const level = Number(column?.getProperties().level);
  if (
    column?.name !== "water" ||
    !Number.isInteger(level) ||
    level < 8 ||
    head?.name !== "water" ||
    ceiling?.name !== "stone"
  ) {
    return {
      status: "failed",
      detail: "Expected a falling water column, water above it, and a low stone exit ceiling.",
    };
  }
  context.log(`Observed falling water level ${level}, water above it, and the low exit ceiling.`);
  return traverseWater(context);
}
