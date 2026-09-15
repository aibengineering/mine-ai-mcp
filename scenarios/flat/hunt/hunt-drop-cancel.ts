import { collectDropAfterDeath, sweepDropsAfterDeath } from "../../../src/actions/hunt-mob/hunt-mob.ts";
import { createDiscardedItems } from "../../../src/world/discarded-items.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Reproduce the two consecutive production pickup waits after a kill without a drop. */
export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const stop = new AbortController();
  const context = { signal: AbortSignal.any([signal, stop.signal]) };
  const observation = {
    entityBaseline: new Set(Object.values(bot.entities).map((entity) => entity.id)),
    deathPosition: bot.entity.position.clone(),
  };
  let ticks = 0;
  const tick = () => {
    ticks++;
  };
  bot.on("physicsTick", tick);
  try {
    const requested = collectDropAfterDeath(
      bot,
      navigation,
      {
        ...observation,
        dropName: "blaze_rod",
        dropId: bot.registry.itemsByName.blaze_rod!.id,
        inventoryBefore: 0,
      },
      context,
      createDiscardedItems(),
    );
    await bot.waitForTicks(1);
    const cancelledAt = ticks;
    stop.abort("The reflex needs the body now.");
    await requested;
    await sweepDropsAfterDeath(bot, navigation, observation, context, createDiscardedItems());
    const delay = ticks - cancelledAt;
    return {
      status: delay <= 1 ? "succeeded" : "failed",
      detail: `post-cancellation pickup settlement took ${delay} physics ticks`,
    };
  } finally {
    bot.off("physicsTick", tick);
  }
};
