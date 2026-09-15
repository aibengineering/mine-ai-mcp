import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Observe the production reflex; the driver never supplies movement or rescue. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal, log } = context;
  const { lowAirStart } = z.object({ lowAirStart: z.boolean().default(false) }).parse(context.scenario.params ?? {});
  if (lowAirStart) {
    // The sealed preparation pocket drains server-owned air naturally. Only
    // then place the bot below the overhang and release it to production control.
    while ((airSupplyTicks(bot) ?? Number.POSITIVE_INFINITY) > 120) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    bot.chat("/tp @s 0.02621917259805 -36 0.08979961991747");
    while (bot.entity.position.x > 2) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
  }
  const runtime = await openRuntime(context, "waterfall-breath");
  let deaths = 0;
  let ticks = 0;
  let sawLowAir = false;
  let sawAirLoss = false;
  let recoveredAir = false;
  let reflexTicks = 0;
  let blockedRiseTicks = 0;
  let minimumHealth = bot.health;
  let previousPosition = bot.entity.position.clone();
  const frame = () => ({
    ticks,
    position: { ...bot.entity.position },
    air: airSupplyTicks(bot),
    health: bot.health,
    controls: Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sneak", "sprint"] as const).map((control) => [
        control,
        bot.getControlState(control),
      ]),
    ),
    owner: runtime.status().owner,
    action: runtime.status().activeAction?.action ?? null,
    centerRoof: bot.blockAt(bot.entity.position.floored().offset(0, 2, 0))?.name,
    overhang: bot.blockAt(new Vec3(0, -31, -1))?.name,
    digging: bot.targetDigBlock?.position ?? null,
  });
  let deathFrame: ReturnType<typeof frame> | null = null;
  const death = () => {
    deaths++;
    minimumHealth = 0;
    deathFrame = frame();
    log(`WATERFALL_DEATH ${JSON.stringify(deathFrame)}`);
  };
  const tick = () => {
    if (deaths > 0) return;
    ticks++;
    minimumHealth = Math.min(minimumHealth, bot.health);
    const air = airSupplyTicks(bot);
    sawAirLoss ||= air !== null && air < 300;
    sawLowAir ||= air !== null && air <= 180;
    recoveredAir ||= sawAirLoss && air !== null && air >= 300;
    if (runtime.status().activeAction?.action === "breath_reflex") {
      reflexTicks++;
      if (bot.controlState.jump && bot.entity.position.distanceTo(previousPosition) < 0.001) blockedRiseTicks++;
    }
    previousPosition = bot.entity.position.clone();
    if (ticks % 10 === 0) log(`WATERFALL_TICK ${JSON.stringify(frame())}`);
  };
  bot.on("death", death);
  bot.on("physicsTick", tick);
  try {
    if (bot.blockAt(bot.entity.position)?.name !== "water")
      throw new Error("The fixture did not start the bot in its falling-water column.");
    if (
      bot.blockAt(bot.entity.position)?.getProperties().level !== "8" ||
      bot.blockAt(new Vec3(0, -31, -1))?.name !== (lowAirStart ? "bedrock" : "deepslate")
    )
      throw new Error("The fixture requires falling water and its neighboring deepslate overhang.");
    log(`WATERFALL_START ${JSON.stringify(frame())}`);
    // Forty seconds covers vanilla air depletion and lethal drowning. Escape
    // before air depletes is also successful; the final air supply is the goal.
    while (ticks < 800 && deaths === 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await runtime.captureIncident();
    return {
      status: deaths === 0 && (airSupplyTicks(bot) ?? -1) >= 300 && minimumHealth >= 14 ? "succeeded" : "failed",
      detail: JSON.stringify({
        deaths,
        sawLowAir,
        recoveredAir,
        minimumHealth,
        reflexTicks,
        blockedRiseTicks,
        deathFrame,
        final: frame(),
      }),
    };
  } finally {
    bot.off("death", death);
    bot.off("physicsTick", tick);
    await runtime.close();
  }
}
