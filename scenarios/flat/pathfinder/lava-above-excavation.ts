import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { createMovements, nearGoal } from "../../../src/navigation/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  // Overworld lava advances every 30 ticks. Let both initial flow steps settle.
  await bot.waitForTicks(80);
  const landing = new Vec3(0, -59, 0);
  const head = landing.offset(0, 1, 0);
  const besideHead = head.offset(-1, 0, 0);
  const initial = [landing, head, besideHead].map((p) => ({
    position: p,
    name: bot.blockAt(p)?.name,
    level: bot.blockAt(p)?.getProperties().level,
  }));
  context.log(`Initial geometry: ${JSON.stringify(initial)}`);
  if (initial[0].name !== "warped_nylium" || initial[1].name !== "nether_sprouts" || initial[2].name !== "lava")
    return { status: "failed", detail: "The excavation and adjacent upper lava were not arranged." };

  const changes: string[] = [];
  let minimumHealth = bot.health;
  let deaths = 0;
  const healthChanged = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const died = () => {
    deaths += 1;
  };
  const observe = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (after && (after.position.equals(landing) || after.position.equals(head)))
      changes.push(`${before?.name}->${after.name} at ${after.position}`);
  };
  bot.on("blockUpdate", observe);
  bot.on("health", healthChanged);
  bot.on("death", died);
  try {
    const result = await context.navigation.navigate({
      movements: createMovements(bot, { scaffolding: false }),
      goal: nearGoal({ x: landing.x, y: landing.y, z: landing.z }, 0.1),
      signal: context.signal,
    });
    // A completed drop precedes the scheduled lava update: observe that update too.
    await bot.waitForTicks(60);
    const preserved = bot.blockAt(landing)?.name === "warped_nylium";
    return {
      status: result.status === "stopped" && preserved && minimumHealth === 20 && deaths === 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        route: result,
        preserved,
        minimumHealth,
        deaths,
        changes,
        position: bot.entity.position,
      }),
    };
  } finally {
    bot.off("blockUpdate", observe);
    bot.off("health", healthChanged);
    bot.off("death", died);
  }
}
