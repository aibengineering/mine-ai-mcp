import { fullProtectionBlock } from "../../../src/survival/positioning/combat/build-protection.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Bridge fixture did not land.");
  const origin = bot.entity.position.floored();
  const target = bot.nearestEntity((entity) => entity.name === "blaze");
  if (!target) throw new Error("Backstop attacker was not observed.");
  const complete = new AbortController();
  const cells = [origin.offset(-1, -1, 0), origin.offset(-1, 0, 0), origin.offset(-1, 1, 0)];
  const built = () => cells.every((cell) => fullProtectionBlock(bot.blockAt(cell)));
  const stop = () => {
    if (built()) complete.abort("Backstop observed; begin collision replay.");
  };
  bot.on("physicsTick", stop);
  let outcome;
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    outcome = await scenarioCombat1.controller.engage(target.id, AbortSignal.any([signal, complete.signal]), "pursue");
  } finally {
    bot.off("physicsTick", stop);
  }
  if (!built()) return { status: "failed", detail: JSON.stringify({ outcome, built: false }) };
  let lowestY = bot.entity.position.y;
  const observe = () => {
    lowestY = Math.min(lowestY, bot.entity.position.y);
  };
  bot.on("physicsTick", observe);
  try {
    // Deliberately injected contact-scale impulse; the live world owns collision.
    // No steering hold assists the backstop during this geometry assertion.
    bot.clearControlStates();
    bot.entity.velocity.set(-0.4, 0.4, 0);
    await bot.waitForTicks(35);
    return {
      status: lowestY >= -50 && bot.entity.onGround && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ built: built(), outcome, lowestY, health: bot.health, position: bot.entity.position }),
    };
  } finally {
    bot.off("physicsTick", observe);
  }
};
