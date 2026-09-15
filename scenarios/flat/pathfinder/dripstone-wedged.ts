import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { Vec3 } from "vec3";

export { run } from "./pathfinder-runner.ts";

export async function prepare({ bot }: MineAiScenarioContext): Promise<void> {
  const tip = bot.blockAt(new Vec3(0, -58, 0));
  if (
    tip?.name !== "pointed_dripstone" ||
    tip.getProperties().vertical_direction !== "up" ||
    tip.shapes.length === 0
  )
    throw new Error(`Expected a supported upward dripstone tip, observed ${tip?.name ?? "air"}.`);

  const [x, y, z] = [0.5, -57, 0.5] as const;
  const target = new Vec3(x, y, z);
  const moved = new Promise<void>((resolve, reject) => {
    let ticks = 0;
    const observe = () => {
      if (bot.entity.position.distanceTo(target) <= 0.1) {
        bot.off("physicsTick", observe);
        resolve();
      } else if (++ticks >= 40) {
        bot.off("physicsTick", observe);
        reject(new Error(`Wedge teleport was not observed at ${bot.entity.position}.`));
      }
    };
    bot.on("physicsTick", observe);
  });
  bot.chat(`/tp @s ${x} ${y} ${z}`);
  await moved;
  await bot.waitForTicks(5);
  const support = bot.blockAt(bot.entity.position.floored());
  if (!bot.entity.onGround || support?.name !== "pointed_dripstone")
    throw new Error(`Dripstone tip did not ground the player at ${bot.entity.position}.`);
}
