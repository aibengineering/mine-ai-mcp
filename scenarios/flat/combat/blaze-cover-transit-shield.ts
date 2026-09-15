import { z } from "zod";
import { isBurning } from "../../../src/survival/perception/body.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  await standStill(context);
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  await bot.equip(shield, "off-hand");
  const target = bot.nearestEntity((entity) => entity.name === "blaze")!;
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const combat = scenarioCombat1.controller;
  const done = new AbortController();
  let launched = false;
  let spawned = false;
  let gone = false;
  let shieldBlocks = 0;
  let minimumHealth = bot.health;
  let ticksAfterShot = 0;
  let projectileId: number | null = null;
  const packetSchema = z.object({ entityId: z.number(), entityStatus: z.number() });
  const status = (raw: unknown) => {
    const parsed = packetSchema.safeParse(raw);
    if (parsed.success && parsed.data.entityId === bot.entity.id && parsed.data.entityStatus === 29) shieldBlocks++;
  };
  const spawn: Parameters<typeof bot.on<"entitySpawn">>[1] = (entity) => {
    if (entity.name === "small_fireball") {
      spawned = true;
      projectileId = entity.id;
    }
  };
  const removed: Parameters<typeof bot.on<"entityGone">>[1] = (entity) => {
    if (entity.id === projectileId) gone = true;
  };
  const release = navigation.onEvent((event) => {
    if (event.kind === "step_started") log(JSON.stringify({ event, plan: combat.activePosition() }));
    if (launched || event.kind !== "step_started" || !combat.activePosition()) return;
    launched = true;
    // Shoot along the passage from the target's side while combat moves out.
    // Armour and regeneration cannot hide a lost guard in this fixture.
    bot.chat("/summon small_fireball 1.5 -59 3.5 {Motion:[0.0d,0.0d,-0.5d]}");
  });
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    if (launched) ticksAfterShot++;
    log(
      JSON.stringify({
        position: bot.entity.position,
        yaw: bot.entity.yaw,
        health: bot.health,
        usingItem: bot.usingHeldItem,
        plan: combat.activePosition(),
        launched,
        spawned,
        gone,
        shieldBlocks,
      }),
    );
    // Observe the whole projectile and a following burn interval. Cancelling
    // ends only this probe engagement; it does not itself count as success.
    if (gone && ticksAfterShot >= 60) done.abort("Projectile observation complete");
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityGone", removed);
  bot.on("physicsTick", tick);
  bot._client.on("entity_status", status);
  try {
    const outcome = await combat.engage(target.id, AbortSignal.any([signal, done.signal]), "pursue");
    return {
      status: spawned && gone && minimumHealth === 20 && !isBurning(bot) ? "succeeded" : "failed",
      detail: JSON.stringify({
        outcome,
        launched,
        spawned,
        gone,
        shieldBlocks,
        minimumHealth,
        health: bot.health,
        burning: isBurning(bot),
      }),
    };
  } finally {
    release();
    bot.off("entitySpawn", spawn);
    bot.off("entityGone", removed);
    bot.off("physicsTick", tick);
    bot._client.off("entity_status", status);
  }
};
