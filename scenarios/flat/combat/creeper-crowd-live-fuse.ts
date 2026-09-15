import { retreatFromCreepers } from "../../../src/survival/responses/fight/creeper-retreat.ts";
import { isSwelling } from "../../../src/survival/perception/combat/creepers.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
  context.bot.chat("/summon creeper 2.5 -60 0.5 {Fuse:30,PersistenceRequired:1b}");
  let creeper = Object.values(context.bot.entities).find((entity) => entity.name === "creeper");
  // The fixture waits at most one ordinary fuse duration for the server's swell observation.
  for (let tick = 0; tick < 30 && (!creeper || !isSwelling(context.bot, creeper)); tick += 1) {
    await context.bot.waitForTicks(1);
    creeper = Object.values(context.bot.entities).find((entity) => entity.name === "creeper");
  }
  if (!creeper || !isSwelling(context.bot, creeper))
    return { status: "failed", detail: "No live swelling creeper was observed." };
  const initialDistance = creeper.position.distanceTo(context.bot.entity.position);
  const outcome = await retreatFromCreepers(context.bot, context.signal, () => context.bot.health <= 0);
  const finalDistance = creeper.position.distanceTo(context.bot.entity.position);
  return {
    status:
      outcome === "finished" && context.bot.health === 20 && finalDistance > 8 && !isSwelling(context.bot, creeper)
        ? "succeeded"
        : "failed",
    detail: JSON.stringify({
      outcome,
      initialDistance,
      finalDistance,
      health: context.bot.health,
      swelling: isSwelling(context.bot, creeper),
      valid: creeper.isValid,
    }),
  };
};
