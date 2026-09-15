import { Vec3 } from "vec3";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context)))
    return { status: "failed", detail: "The bot did not settle at the tunnel approach." };
  const floor = bot.blockAt(new Vec3(87, 38, -21));
  const beneath = bot.blockAt(new Vec3(87, 37, -21));
  if (floor?.name !== "gravel" || beneath?.name !== "air")
    return { status: "failed", detail: "The native suspended gravel column was not present before collection." };
  let lavaContact = false;
  let minimumHealth = bot.health;
  let deaths = 0;
  const observe = () => {
    lavaContact ||= Reflect.get(bot.entity, "isInLava") === true || bot.blockAt(bot.entity.position)?.name === "lava";
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  bot.on("physicsTick", observe);
  bot.on("death", death);
  await using runtime = await openRuntime(context, "gravel-overhang-mining");
  try {
    const result = await runtime.run(
      runtime.actions.find((action) => action.name === "collect_block")!,
      { block_name: "nether_gold_ore", count: 1, x: 88, y: 38, z: -21, scaffold: true },
      signal,
    );
    // The original downward step reported completion before the gravel fell.
    // Keep observing for two seconds after settlement to catch delayed collapse.
    await bot.waitForTicks(40);
    const safeRefusal =
      result.result.status === "failed" && result.result.error.includes("[NO_REACHABLE_MATCHING_TARGETS]");
    const settled = result.result.status === "succeeded" || safeRefusal;
    return {
      status:
        settled && !lavaContact && minimumHealth === 20 && deaths === 0 && bot.entity.onGround ? "succeeded" : "failed",
      detail: JSON.stringify({
        action: result.result,
        lavaContact,
        minimumHealth,
        deaths,
        position: bot.entity.position,
      }),
    };
  } finally {
    bot.off("physicsTick", observe);
    bot.off("death", death);
  }
};
