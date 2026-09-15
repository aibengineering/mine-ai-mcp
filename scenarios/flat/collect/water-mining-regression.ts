import { Vec3 } from "vec3";
import { SqlBotData } from "../../../src/bot-data/index.ts";
import { createMovements } from "../../../src/navigation/index.ts";
import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import { ActionRunner } from "../../../src/session/action-runner.ts";
import { attachIdleWaterControl } from "../../../src/survival/baseline/idle-water.ts";
import { ReflexDriver } from "../../../src/survival/control/driver.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { attachBreathReflex } from "../../../src/survival/reflexes/breath.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await bot.waitForChunksToLoad();
  const mode = context.scenario.params.mode;
  if (mode === "cancel") {
    const data = SqlBotData.create({
      storage: { kind: "temporary" },
      identity: { worldId: "current-cancel", scope: { kind: "bot", botId: bot.username } },
    });
    const runner = new ActionRunner();
    // The physical primitive owns the body until cancellation settles. The
    // idle water controller takes over at that exact boundary.
    let digging = true;
    await using resources = new AsyncDisposableStack();
    const driver = resources.use(new ReflexDriver(bot, runner));
    resources.use(attachBreathReflex(bot, driver));
    resources.use(
      attachIdleWaterControl(
        bot,
        {
          get active() {
            return digging;
          },
        },
        runner,
      ),
    );
    const stop = new AbortController();
    let digTicks = 0;
    const tick = () => {
      // The dig is admitted while dry; native flow then reaches it. A caller
      // must not bypass liquid safety just to arrange the cancellation test.
      if (bot.targetDigBlock && digTicks === 0) bot.chat("/setblock 0 -59 0 water");
      if (bot.targetDigBlock && ++digTicks === 20) stop.abort("Scenario cancellation during a submerged obsidian dig");
    };
    bot.on("physicsTick", tick);
    const start = bot.entity.position.clone();
    try {
      await context.navigation
        .breakBlockInPlace({
          movements: createMovements(bot),
          position: { x: 2, y: -59, z: 1 },
          signal: AbortSignal.any([signal, stop.signal]),
        })
        .catch((error) => {
          if (!stop.signal.aborted) throw error;
        });
      digging = false;
      const cancelledAt = bot.entity.position.clone();
      await bot.waitForTicks(80);
      const drift = Math.hypot(cancelledAt.x - bot.entity.position.x, cancelledAt.z - bot.entity.position.z);
      return {
        status: stop.signal.aborted && !bot.targetDigBlock && drift < 0.3 && bot.health === 20 ? "succeeded" : "failed",
        detail: JSON.stringify({
          digTicks,
          horizontalDrift: drift,
          verticalRise: bot.entity.position.y - cancelledAt.y,
          displacement: start.distanceTo(bot.entity.position),
          health: bot.health,
          target: bot.targetDigBlock?.name,
        }),
      };
    } finally {
      bot.off("physicsTick", tick);
      data.close();
    }
  }
  await using runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: `water-mining-${mode}`, scope: { kind: "bot", botId: bot.username } },
    },
  });
  if (mode === "lava" || mode === "lava-dig") {
    const collect = runtime.actions.find((action) => action.name === "collect_block");
    if (!collect) throw new Error("Collect action missing");
    let injected = false;
    const inject = () => {
      if (injected || !bot.targetDigBlock) return;
      injected = true;
      bot.chat("/setblock 0 -60 0 lava");
    };
    if (mode === "lava-dig") bot.on("physicsTick", inject);
    const mining =
      mode === "lava-dig" ? runtime.run(collect, { block_name: "obsidian", count: 1, scaffold: false }, signal) : null;
    let sawLava = false;
    let escaped = 0;
    for (let tick = 0; tick < 200 && bot.health > 0; tick++) {
      signal.throwIfAborted();
      sawLava ||= isInLava(bot);
      escaped = sawLava && !isInLava(bot) && !isBurning(bot) ? escaped + 1 : 0;
      if (escaped >= 10) break;
      await bot.waitForTicks(1);
    }
    bot.off("physicsTick", inject);
    const result = await mining;
    return {
      status: sawLava && escaped >= 10 && bot.health > 0 && !bot.targetDigBlock ? "succeeded" : "failed",
      detail: JSON.stringify({
        sawLava,
        injected,
        escaped,
        health: bot.health,
        position: bot.entity.position,
        lava: isInLava(bot),
        burning: isBurning(bot),
        mining: result?.result,
      }),
    };
  }
  let wetDig = false;
  let dug = false;
  const tick = () => {
    if (bot.targetDigBlock?.name !== "obsidian") return;
    dug = true;
    wetDig ||= Reflect.get(bot.entity, "isInWater") === true || bot.blockAt(new Vec3(2, -59, 0))?.name === "water";
  };
  bot.on("physicsTick", tick);
  try {
    const collect = runtime.actions.find((action) => action.name === "collect_block");
    if (!collect) throw new Error("Collect action missing");
    const result = await runtime.run(collect, { block_name: "obsidian", count: 1, scaffold: false }, signal);
    const count = bot.inventory
      .items()
      .filter((item) => item.name === "obsidian")
      .reduce((sum, item) => sum + item.count, 0);
    const recovered = mode !== "scoop" || bot.inventory.items().some((item) => item.name === "water_bucket");
    return {
      status: result.result.status === "succeeded" && count >= 1 && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ result: result.result, dug, wetDig, recovered, count, health: bot.health }),
    };
  } finally {
    bot.off("physicsTick", tick);
  }
};
