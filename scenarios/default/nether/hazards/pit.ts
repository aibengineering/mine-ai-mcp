import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { standStill, wearArmor } from "../../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../../src/scenario-client.ts";

export interface Site {
  start: Vec3;
  target: Vec3;
  refuge: Vec3;
  drop: { x: number; z: number; top: number; bottom: number }[];
}
export const cliff: Site = {
  start: new Vec3(71, 65, -20),
  target: new Vec3(70, 66, -18),
  refuge: new Vec3(66, 68, -20),
  drop: [{ x: 72, z: -20, top: 64, bottom: 51 }],
};
export const canopy: Site = {
  start: new Vec3(104, 64, -12),
  target: new Vec3(108, 64, -12),
  refuge: new Vec3(102, 65, -15),
  drop: [
    { x: 105, z: -12, top: 63, bottom: 53 },
    { x: 106, z: -12, top: 63, bottom: 54 },
    { x: 107, z: -12, top: 63, bottom: 54 },
  ],
};

export async function observe(bot: Bot, fact: () => boolean, label: string): Promise<void> {
  // Arrangement and explicit stimulus must settle before the runner's outer deadline.
  for (let tick = 0; tick < 400; tick++) {
    if (fact()) return;
    await bot.waitForTicks(1);
  }
  throw new Error(`Did not observe ${label} within 20 seconds.`);
}

/**
 * Confirm the survey a site relies on, then dress. Mine Labs has already put
 * the bot on the site's lip in the Nether; the standing cells and drop
 * columns are checked against the generated terrain before anything moves.
 */
export async function arrange(context: MineAiScenarioContext, site: Site): Promise<void> {
  const { bot, log } = context;
  const lip = site.start;
  await bot.waitForChunksToLoad();
  if (bot.game.dimension !== "the_nether" || bot.entity.position.distanceTo(lip.offset(0.5, 0, 0.5)) > 1)
    throw new Error(`Expected to start on the Nether lip ${lip}, not ${bot.entity.position} in ${bot.game.dimension}.`);
  for (const point of [lip, site.target, site.refuge]) {
    if (
      bot.blockAt(point.offset(0, -1, 0))?.boundingBox !== "block" ||
      [0, 1, 2].some((dy) => bot.blockAt(point.offset(0, dy, 0))?.boundingBox !== "empty")
    )
      throw new Error(`Surveyed standing cell changed: ${point}.`);
  }
  const columns = site.drop.map((column) => {
    const blocks: { y: number; name: string | undefined; clear: boolean }[] = [];
    for (let y = column.bottom; y <= column.top; y++) {
      const block = bot.blockAt(new Vec3(column.x, y, column.z));
      blocks.push({
        y,
        name: block?.name,
        clear: block?.boundingBox === "empty" && block.name !== "water" && block.name !== "lava",
      });
    }
    return { ...column, blocks };
  });
  if (columns.some((column) => column.blocks.some((block) => !block.clear)))
    throw new Error(`Surveyed vertical drop changed: ${JSON.stringify(columns)}`);
  log(`Native vertical drop clearance: ${JSON.stringify(columns)}`);
  if (!(await standStill(context))) throw new Error("Could not settle on the pit lip.");
  await wearArmor(context);
  let confirmed = false;
  const onMessage = (message: string) => {
    if (message === "HAZARD_ARMOR_CONFIRMED") confirmed = true;
  };
  bot.on("messagestr", onMessage);
  try {
    bot.chat(
      '/execute if items entity @s armor.head iron_helmet if items entity @s armor.chest iron_chestplate if items entity @s armor.legs iron_leggings if items entity @s armor.feet golden_boots run tellraw @s "HAZARD_ARMOR_CONFIRMED"',
    );
    await observe(bot, () => confirmed, "server equipment confirmation");
  } finally {
    bot.off("messagestr", onMessage);
  }
  log("Server confirmed all four expedition armor slots.");
}
