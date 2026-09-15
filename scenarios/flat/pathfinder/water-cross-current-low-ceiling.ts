import { Vec3 } from "vec3";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
export { run } from "./water-traversal.ts";

export async function prepare({ bot, scenario }: MineAiScenarioContext): Promise<void> {
  // Let native water updates establish the diagonal current before the swim.
  await bot.waitForTicks(100);
  const [x, y, z] = scenario.players[0]!.pos!;
  const moved = new Promise<void>((resolve) => bot.once("forcedMove", () => resolve()));
  bot.chat(`/tp @s ${x} ${y} ${z}`);
  await moved;
  const water = bot.blockAt(new Vec3(2, -58, 0));
  if (water?.name !== "water" || Number(water.getProperties().level) === 0)
    throw new Error("The crossing must contain native flowing water.");
}
