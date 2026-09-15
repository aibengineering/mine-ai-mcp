/** Arrangement checks and observed combat evidence shared by the fortress trials. */
import type { Entity } from "prismarine-entity";
import { z } from "zod";
import { declaredEntitiesArranged, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** The surveyed exit a fortress trial returns to. Everything else is declared in the scenario file. */
export const fortressParamsSchema = z.strictObject({
  exit: z.tuple([z.number(), z.number(), z.number()]),
});
export type FortressParams = z.output<typeof fortressParamsSchema>;

/**
 * Confirm what the scenario file arranged, then dress for the fight.
 *
 * Mine Labs has already put the bot on its surveyed floor in the Nether,
 * wounded it if the scenario says so, and summoned every declared threat
 * with its AI off. The driver checks that the survey still holds and that
 * the threats are loaded; nothing here moves anything.
 */
export async function prepareFortress(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  if (bot.inventory.items().some((item) => item.name === "blaze_rod"))
    throw new Error("Fortress trial must begin without blaze rods.");
  await bot.waitForChunksToLoad();
  const ground = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
  if (ground?.name !== "nether_bricks")
    throw new Error(`Surveyed fortress floor is ${ground?.name}, not nether_bricks.`);
  if (!(await standStill(context))) throw new Error("Fortress arrangement did not settle on its surveyed floor.");
  await wearArmor(context);
  await declaredEntitiesArranged(context);
  context.log(
    `ARRANGED ${JSON.stringify({ dimension: bot.game.dimension, position: bot.entity.position, health: bot.health, threats: context.scenario.entities })}`,
  );
}

/** The final arrangement command; no operator writes follow it in either trial. */
export async function releaseThreats(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  let acknowledge = () => {};
  let rejectAcknowledgement = (_reason: unknown) => {};
  const acknowledged = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    rejectAcknowledgement = reject;
  });
  const abort = () => rejectAcknowledgement(context.signal.reason);
  const message = (text: string) => {
    if (text.includes("fortress_native_ai_ready")) acknowledge();
  };
  bot.on("messagestr", message);
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    bot.chat("/execute as @e[tag=fortress_trial] run data merge entity @s {NoAI:0b}");
    // The connection's commands execute in order. This message confirms AI
    // release was processed before the first measured action can attack.
    bot.chat("/say fortress_native_ai_ready");
    await acknowledged;
  } finally {
    bot.off("messagestr", message);
    context.signal.removeEventListener("abort", abort);
  }
}

export function observeFortress(context: MineAiScenarioContext) {
  const { bot } = context;
  const started = Date.now();
  const initialHealth = bot.health;
  const start = bot.entity.position.clone();
  const dimension = bot.game.dimension;
  let maximumDistanceFromStart = 0;
  let minimumY = bot.entity.position.y;
  let maximumY = bot.entity.position.y;
  const initialArrows = bot.inventory
    .items()
    .filter((item) => item.name === "arrow")
    .reduce((total, item) => total + item.count, 0);
  let previousHealth = initialHealth;
  let minimumHealth = initialHealth;
  let damage = 0;
  let deaths = 0;
  let ticks = 0;
  let hurtEvents = 0;
  let fireballs = 0;
  const mobDeaths: Record<string, number> = {};
  const health = () => {
    damage += Math.max(0, previousHealth - bot.health);
    previousHealth = bot.health;
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  const mobDead = (entity: Entity) => {
    if (entity.name) mobDeaths[entity.name] = (mobDeaths[entity.name] ?? 0) + 1;
  };
  const hurtEntity = (entity: Entity) => {
    if (entity.id === bot.entity.id) hurtEvents++;
  };
  const spawnEntity = (entity: Entity) => {
    if (entity.name === "small_fireball" || entity.name === "fireball") fireballs++;
  };
  const snapshot = () => ({
    elapsedMs: Date.now() - started,
    deaths,
    initialHealth,
    minimumHealth,
    health: bot.health,
    damage,
    minimumY,
    maximumY,
    maximumDistanceFromStart,
    mobDeaths,
    hurtEvents,
    fireballs,
    dimension: bot.game.dimension,
    position: bot.entity.position,
    rods: bot.inventory
      .items()
      .filter((item) => item.name === "blaze_rod")
      .reduce((total, item) => total + item.count, 0),
    arrowsConsumedNet:
      initialArrows -
      bot.inventory
        .items()
        .filter((item) => item.name === "arrow")
        .reduce((total, item) => total + item.count, 0),
  });
  const tick = () => {
    // Respawn belongs to the death verdict, not the fortress movement range.
    if (deaths === 0 && bot.game.dimension === dimension) {
      minimumY = Math.min(minimumY, bot.entity.position.y);
      maximumY = Math.max(maximumY, bot.entity.position.y);
      maximumDistanceFromStart = Math.max(maximumDistanceFromStart, bot.entity.position.distanceTo(start));
    }
    if (++ticks % 20 === 0) context.log(`COMBAT ${JSON.stringify(snapshot())}`);
  };
  bot.on("health", health);
  bot.on("death", death);
  bot.on("entityDead", mobDead);
  bot.on("entityHurt", hurtEntity);
  bot.on("entitySpawn", spawnEntity);
  bot.on("physicsTick", tick);
  return {
    snapshot,
    close: () => {
      bot.off("health", health);
      bot.off("death", death);
      bot.off("entityDead", mobDead);
      bot.off("entityHurt", hurtEntity);
      bot.off("entitySpawn", spawnEntity);
      bot.off("physicsTick", tick);
    },
  };
}
