import type { Bot } from "mineflayer";
import { horizontalControlsToward } from "../../navigation/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { airSupplyPoints, FULL_AIR_POINTS, isInWater } from "../perception/body.js";
import { nearbySwimEscape, swimmingRoof } from "../positioning/swim-escape.js";
import type { Budgets } from "../state/budgets.js";
/**
 * Rise for air, swimming clear of an overhang or digging a sealed roof, until
 * the bar is full or the time is up.
 */
export async function surface(bot: Bot, signal: AbortSignal, budgets: Budgets, maximumTicks: number) {
  let dug = 0;
  let ticks = 0;
  const tick = () => {
    ticks++;
  };
  using budget = budgets.attempt({
    name: "surface.rise",
    scope: "surface",
    unit: "ticks",
    limit: maximumTicks,
    measure: () => ticks,
    exhaustion: "stuck",
  });
  let escape: ReturnType<typeof nearbySwimEscape> = null;
  const blocked: NonNullable<ReturnType<typeof nearbySwimEscape>>[] = [];
  let bestDistance = Infinity;
  let stalledTicks = 0;
  signal.throwIfAborted();
  const stopDigging = () => {
    if (bot.targetDigBlock) bot.stopDigging();
  };
  signal.addEventListener("abort", stopDigging, { once: true });
  bot.on("physicsTick", tick);
  bot.setControlState("jump", true);
  try {
    while (!budget.exhausted) {
      signal.throwIfAborted();
      const air = airSupplyPoints(bot);
      // Respawn can replace the body's metadata. Unknown air cannot retain
      // ownership on the strength of an old oxygenLevel value.
      if (air === null || air >= FULL_AIR_POINTS) break;
      const roof = isInWater(bot) ? swimmingRoof(bot) : null;
      if (bot.health <= 0) break;
      if (escape) {
        const distance = Math.hypot(bot.entity.position.x - escape.x, bot.entity.position.z - escape.z);
        if (distance < bestDistance - 0.02) {
          bestDistance = distance;
          stalledTicks = 0;
        } else stalledTicks++;
        // One second without closing distance leaves time to try another
        // corridor or dig. Holding a failed lateral input can drown too.
        if (distance < 0.08 || stalledTicks >= 20) {
          if (stalledTicks >= 20) blocked.push(escape);
          escape = null;
        }
      }
      if (roof && !escape) {
        escape = nearbySwimEscape(bot, blocked);
        bestDistance = Infinity;
        stalledTicks = 0;
      }
      const horizontal = escape ? horizontalControlsToward(bot.entity, escape, 0.05) : null;
      for (const control of ["forward", "back", "left", "right"] as const)
        bot.setControlState(control, horizontal?.[control] ?? false);
      if (roof?.diggable && !escape) {
        try {
          await bot.dig(roof);
          dug += 1;
        } catch {
          signal.throwIfAborted();
          // A refused dig yields one tick before another attempt.
        }
      }
      await waitForPhysicsTicks(bot, 1, signal);
    }
  } finally {
    bot.off("physicsTick", tick);
    signal.removeEventListener("abort", stopDigging);
    bot.setControlState("jump", false);
    for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, false);
  }
  const airAfter = airSupplyPoints(bot);
  return {
    kind:
      bot.health <= 0
        ? ("bot_died" as const)
        : airAfter === null
          ? ("air_unknown" as const)
          : airAfter >= FULL_AIR_POINTS
            ? ("air_full" as const)
            : ("stuck" as const),
    dug,
    airAfter,
  };
}
