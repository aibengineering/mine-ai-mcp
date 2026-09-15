import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function prepare({ bot }: MineAiScenarioContext): Promise<void> {
  await bot.waitForTicks(60);
}

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await using runtime = await openRuntime(context, "mining-water-safety");
  const flowing = context.scenario.params.mode === "flowing";
  const roof = context.scenario.params.mode === "roof";
  const wanted = flowing ? 3 : 1;
  let wet = false;
  let minHealth = bot.health;
  let digTicks = 0;
  let arrivals = 0;
  const start = Date.now();
  const tick = () => {
    wet ||= Reflect.get(bot.entity, "isInWater") === true;
    minHealth = Math.min(minHealth, bot.health);
    if (bot.targetDigBlock) digTicks++;
  };
  const off = runtime.navigation.onEvent((event) => {
    if (event.kind === "goal_arrived") arrivals++;
  });
  bot.on("physicsTick", tick);
  try {
    const collect = runtime.actions.find((action) => action.name === "collect_block")!;
    const output = await runtime.run(collect, { block_name: "stone", count: wanted, scaffold: true }, signal);
    await bot.waitForTicks(20);
    const gained = bot.inventory.items().filter((item) => item.name === "cobblestone")
      .reduce((sum, item) => sum + item.count, 0);
    const roofIntact = !roof || bot.blockAt(new Vec3(1, -60, 0))?.name === "stone";
    const elapsedMs = Date.now() - start;
    return {
      status: output.result.status === "succeeded" && gained >= wanted && minHealth === 20 &&
        (flowing ? wet : !wet) && roofIntact && elapsedMs < 45_000 ? "succeeded" : "failed",
      detail: JSON.stringify({ result: output.result, gained, wet, roofIntact, minHealth, elapsedMs, digTicks, arrivals }),
    };
  } finally {
    bot.off("physicsTick", tick);
    off();
  }
};
