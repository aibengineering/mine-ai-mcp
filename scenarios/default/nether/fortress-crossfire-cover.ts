import type { BotEvents } from "mineflayer";
import { hideInPlace } from "../../../src/survival/responses/hide.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { prepareFortress, releaseThreats } from "./fortress-common.ts";

/** Isolate physical cover under native fortress fire; this does not claim a rod-collection success. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await prepareFortress(context);
  let shots = 0;
  let covered = false;
  let hitsAfterCover = 0;
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "small_fireball") shots++;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (covered && entity.id === bot.entity.id && source?.name === "blaze") hitsAfterCover++;
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityHurt", hurt);
  try {
    await releaseThreats(context);
    while (shots === 0 && bot.health > 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const healthBefore = bot.health;
    using responseOwner1 = new ScenarioCombat(bot, context.navigation);
    const shelter = await hideInPlace(bot, {
      signal,
      threatContext: {
        ...responseOwner1.context,
        resolvedIds: new Set(),
        attackerIds: new Set(),
        unreachableIds: new Set(),
      },
      recoverTo: 18,
      maximumMs: 60_000,
    });
    covered = shelter.kind !== "failed";
    // Outlast fire already burning when construction finished; the shelter
    // should exclude new blaze hits without consuming a shield.
    for (let tick = 0; tick < 400 && bot.health > 0; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const detail = JSON.stringify({ shots, healthBefore, shelter, hitsAfterCover, health: bot.health });
    log(`FORTRESS COVER ${detail}`);
    return {
      status: shots > 0 && covered && hitsAfterCover === 0 && bot.health >= 18 ? "succeeded" : "failed",
      detail,
    };
  } finally {
    bot.off("entitySpawn", spawn);
    bot.off("entityHurt", hurt);
  }
};
