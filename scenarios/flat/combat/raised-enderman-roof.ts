import { SupportedPositionHold } from "../../../src/navigation/steering/supported-position.ts";
import { CombatPosition } from "../../../src/survival/positioning/combat/position.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

/** Isolate construction from the later fight; the enderman remains neutral. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Raised starting cell did not settle.");
  const target = bot.nearestEntity((entity) => entity.name === "enderman");
  if (!target) throw new Error("Native enderman was not observed.");
  using responseOwner1 = new ScenarioCombat(bot, navigation);
  const position = new CombatPosition(
    bot,
    navigation,
    target,
    new Set(),
    responseOwner1.perception,
    () => responseOwner1.controller.policy.combat,
    responseOwner1.survival.answered,
  );
  const footing = new SupportedPositionHold(bot, navigation.world);
  const tick = () => footing.tick();
  bot.on("physicsTick", tick);
  footing.start();
  try {
    const stopped = await position.prepareRoof(signal, footing, { kind: "protection" });
    const roof = position.hasHeightProtection();
    return {
      status: stopped === null && roof && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ stopped, roof, health: bot.health, position: bot.entity.position }),
    };
  } finally {
    await footing.stop();
    bot.off("physicsTick", tick);
  }
};
