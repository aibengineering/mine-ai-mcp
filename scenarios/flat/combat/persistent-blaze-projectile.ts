import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeExecution } from "../../../src/execution/execution-scope.ts";
import { incomingShieldProjectiles } from "../../../src/survival/perception/combat/shield-projectiles.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  if (!(await standStill(context))) throw new Error("Player did not settle on the arena floor.");
  const target = Object.values(bot.entities).find((entity) => entity.name === "blaze");
  if (!target) throw new Error("Arranged blaze was not observed.");
  // A slow native projectile leaves enough time to ready the shield before it
  // hits. Its position and velocity come from server packets, never a bot mock.
  bot.chat("/summon minecraft:small_fireball 0.5 -59 8.5 {Motion:[0.0d,0.0d,-0.05d]}");
  while (!incomingShieldProjectiles(bot)[0]) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  let ticks = 0;
  let attempts = 0;
  let yields = 0;
  const removeObserver = observeExecution((event) => {
    if (event.owner.operation === "combat" && event.kind === "yielded") {
      yields++;
      if (event.firstYield) log(`EXECUTION_YIELD ${JSON.stringify(event)}`);
    }
  });
  const tick = () => {
    ticks++;
  };
  bot.on("physicsTick", tick);
  const heartbeat = setInterval(
    () => log(`HEARTBEAT ${JSON.stringify({ pid: process.pid, ticks, attempts, memory: process.memoryUsage() })}`),
    1000,
  );
  const navigation = {
    ...context.navigation,
    navigate: async (request: Parameters<typeof context.navigation.navigate>[0]) => {
      attempts++;
      if (attempts === 100) {
        const projectile = incomingShieldProjectiles(bot)[0];
        writeFileSync(
          join(process.env.MINE_LABS_ARTIFACTS_DIR ?? process.cwd(), "approach-spin.json"),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              pid: process.pid,
              attempts,
              ticks,
              stopReason: request.stopSignal?.reason,
              position: bot.entity.position,
              projectile: projectile && {
                id: projectile.id,
                position: projectile.position,
                velocity: projectile.velocity,
              },
              stack: new Error("100 guarded approach attempts").stack,
            },
            null,
            2,
          ),
        );
      }
      return context.navigation.navigate(request);
    },
  };
  try {
    log(
      `ENGAGE ${JSON.stringify({ target: target.id, position: bot.entity.position, projectile: incomingShieldProjectiles(bot)[0]?.position })}`,
    );
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const result = await scenarioCombat1.controller.engage(target.id, signal, "pursue");
    return {
      status: result.kind === "died" ? "succeeded" : "failed",
      detail: JSON.stringify({ result, ticks, attempts, yields }),
    };
  } finally {
    clearInterval(heartbeat);
    removeObserver();
    bot.off("physicsTick", tick);
  }
};
