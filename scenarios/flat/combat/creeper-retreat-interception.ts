import { retreatFromCreepers } from "../../../src/survival/responses/fight/creeper-retreat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Move a native entity into the escape line after the heading is committed.
 * Keeping it stationary then makes avoidance measurable without a chase. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  const creeper = Object.values(bot.entities).find(e => e.name === "creeper")!;
  const husk = Object.values(bot.entities).find(e => e.name === "husk")!;
  if (!creeper || !husk) throw new Error("Both fixture mobs must be loaded.");
  let ticks = 0;
  let intercepted = false;
  let minimumMobDistance = Infinity;
  const initialFuseDistance = bot.entity.position.distanceTo(creeper.position);
  let minimumFuseDistance = initialFuseDistance;
  const samples: unknown[] = [];
  const observe = () => {
    ticks++;
    if (ticks === 3) {
      const heading = bot.entity.position.minus(creeper.position); heading.y = 0;
      const crossing = bot.entity.position.plus(heading.normalize().scaled(2.5));
      bot.chat(`/tp @e[type=husk,limit=1] ${crossing.x} ${crossing.y} ${crossing.z}`);
    }
    if (ticks > 3 && husk.position.z < 5) intercepted = true;
    if (intercepted) minimumMobDistance = Math.min(minimumMobDistance, bot.entity.position.distanceTo(husk.position));
    minimumFuseDistance = Math.min(minimumFuseDistance, bot.entity.position.distanceTo(creeper.position));
    samples.push({ ticks, position: bot.entity.position.clone(), husk: husk.position.clone(), intercepted });
  };
  bot.on("physicsTick", observe);
  try {
    const outcome = await retreatFromCreepers(bot, context.signal, () => ticks >= 20);
    context.log(JSON.stringify({ event: "retreat_interception", samples }));
    return {
      status: intercepted && outcome === "interrupted" && minimumMobDistance >= 1.1 &&
        minimumFuseDistance >= initialFuseDistance - 0.01 ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, intercepted, minimumMobDistance, minimumFuseDistance, initialFuseDistance, ticks }),
    };
  } finally { bot.off("physicsTick", observe); }
};
