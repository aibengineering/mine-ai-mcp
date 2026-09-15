import { observeHuntDrops } from "../../../src/actions/hunt-mob/drop-accounting.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Native item movement and removal must leave geometry evidence in the public drop record. */
export const run: MineAiScenario = async ({ bot, signal }) => {
  const lifetime = new AbortController();
  const read = observeHuntDrops(bot, "magma_cream", AbortSignal.any([signal, lifetime.signal]));
  const cream = bot.registry.itemsByName.magma_cream!.id;
  const before = bot.inventory.count(cream, null);
  try {
    bot.chat('/summon item 0.5 -59.5 0.5 {Item:{id:"minecraft:magma_cream",count:1},PickupDelay:32767s}');
    for (;;) {
      signal.throwIfAborted();
      const drop = read().find((sighting) => sighting.item === "magma_cream");
      if (drop?.state === "no_longer_observed") {
        return {
          status:
            drop.blocks.atPosition === "lava" &&
            !drop.collectedByBot &&
            !drop.collectedByOther &&
            bot.inventory.count(cream, null) === before
              ? "succeeded"
              : "failed",
          detail: JSON.stringify(drop),
        };
      }
      await bot.waitForTicks(1);
    }
  } finally {
    lifetime.abort();
  }
};
