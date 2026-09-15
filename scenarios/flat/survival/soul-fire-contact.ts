import { isBurning, isInFire } from "../../../src/survival/perception/body.ts";
import { z } from "zod";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Fire appears under an idle body, as it did just after the fortress route settled. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const { duringCombat, destination } = z
    .object({
      duringCombat: z.boolean().default(false),
      destination: z.tuple([z.number(), z.number(), z.number()]).optional(),
    })
    .parse(context.scenario.params ?? {});
  if (!(await standStill(context))) throw new Error("Fire-contact start did not settle.");
  await using runtime = await openRuntime(context, "soul-fire-contact");
  let sourceObserved = false;
  let died = false;
  const ignition = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (after?.name === "soul_fire" && before?.name !== "soul_fire") sourceObserved = true;
  };
  const death = () => {
    died = true;
  };
  bot.on("blockUpdate", ignition);
  bot.on("death", death);
  try {
    const action = destination ? runtime.actions.find((candidate) => candidate.name === "navigate") : null;
    if (destination && !action) throw new Error("Missing production navigation action.");
    const pending =
      action && destination
        ? runtime.run(action, { x: destination[0], y: destination[1], z: destination[2], range: 1 }, signal)
        : null;
    // This only arranges when the hazard appears. The verdict requires no
    // particular response, claim count, route, weapon or construction tactic.
    while (duringCombat && (runtime.status().survival.owner.current !== "hostile_reflex" || !bot.entity.onGround)) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const source = bot.entity.position.floored();
    bot.chat(`/setblock ${source.x} ${source.y} ${source.z} soul_fire`);
    // Observe through vanilla's residual burn, not just the first movement.
    for (let tick = 0; tick < 240 && !died; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const navigation = await pending;
    return {
      status:
        sourceObserved &&
        !died &&
        bot.health > 0 &&
        !isInFire(bot) &&
        !isBurning(bot) &&
        (!destination || navigation?.result.status === "succeeded")
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        sourceObserved,
        died,
        health: bot.health,
        inFire: isInFire(bot),
        burning: isBurning(bot),
        position: bot.entity.position,
        navigation,
        survival: runtime.status().survival,
      }),
    };
  } finally {
    bot.off("blockUpdate", ignition);
    bot.off("death", death);
  }
};
