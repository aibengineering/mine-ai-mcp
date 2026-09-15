import { retreatFromCreepers } from "../../../src/survival/responses/fight/creeper-retreat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
  const creeper = Object.values(context.bot.entities).find((entity) => entity.name === "creeper");
  if (!creeper) throw new Error("Fixture creeper was not loaded.");
  const initialDistance = creeper.position.distanceTo(context.bot.entity.position);
  let minimumDistance = initialDistance;
  let ticks = 0;
  const sample = () => {
    ticks += 1;
    minimumDistance = Math.min(minimumDistance, creeper.position.distanceTo(context.bot.entity.position));
  };
  context.bot.on("physicsTick", sample);
  try {
    await retreatFromCreepers(context.bot, context.signal, () => ticks >= 8);
    const finalDistance = creeper.position.distanceTo(context.bot.entity.position);
    return {
      status: minimumDistance >= initialDistance - 0.01 && finalDistance > initialDistance ? "succeeded" : "failed",
      detail: JSON.stringify({ initialDistance, minimumDistance, finalDistance, ticks }),
    };
  } finally {
    context.bot.removeListener("physicsTick", sample);
  }
};
