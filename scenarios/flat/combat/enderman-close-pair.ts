import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";

async function observeHunt(context: MineAiScenarioContext) {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("Pair hunter did not settle.");
  await wearArmor(context);
  let combat!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "enderman-close-pair", {
    createCombatController: (...dependencies) => (combat = createCombatController(...dependencies)),
  });
  let roofRefused = false;
  let stoppedWaiting = false;
  const unsubscribe = combat.onDecision((event) => {
    roofRefused ||= event.kind === "roof_prepared" && event.stopped !== null;
    stoppedWaiting ||= event.kind === "roof_engagement" && event.state === "stopped" && event.noProgressTicks >= 300;
  });
  const hunt = runtime.actions.find((action) => action.name === "collect_mob_drop")!;
  const dead = new AbortController();
  let minimumHealth = bot.health;
  const death = () => {
    minimumHealth = 0;
    dead.abort("Native enderman killed the bot.");
  };
  let kills = 0;
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const killed = (entity: Parameters<typeof bot.attack>[0]) => {
    if (entity.name === "enderman") kills++;
  };
  bot.on("death", death);
  bot.on("physicsTick", tick);
  bot.on("entityDead", killed);
  try {
    bot.chat("/execute as @e[tag=pair] run data merge entity @s {NoAI:0b}");
    const result = await runtime.run(
      hunt,
      { mob_name: "enderman", drop_name: "ender_pearl", count: 1 },
      AbortSignal.any([signal, dead.signal]),
    );
    // Keep the existing reflex alive long enough to observe the handoff, which
    // accounted for the final four hits in the original death.
    for (let tick = 0; tick < 100 && !dead.signal.aborted; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    return { result: result.result, roofRefused, stoppedWaiting, kills, minimumHealth, died: dead.signal.aborted };
  } finally {
    bot.off("death", death);
    bot.off("physicsTick", tick);
    bot.off("entityDead", killed);
    unsubscribe();
    await runtime.close();
  }
}

export const run: MineAiScenario = async (context) => {
  const evidence = await observeHunt(context);
  return {
    status: !evidence.died && evidence.kills > 0 && evidence.minimumHealth >= 12 ? "succeeded" : "failed",
    detail: JSON.stringify(evidence),
  };
};
