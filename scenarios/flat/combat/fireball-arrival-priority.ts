import { z } from "zod";
import { incomingShieldProjectiles } from "../../../src/survival/perception/combat/shield-projectiles.ts";
import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { guardRetreatProjectiles } from "../../../src/survival/weapons/projectile-guard.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** A physical replay of crossfire ordering, not a model of blaze attack AI. */
export const run: MineAiScenario = async ({ bot, navigation, signal, log }) => {
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  await bot.equip(shield, "off-hand");
  bot.activateItem(true);
  await bot.waitForTicks(5);
  let blocks = 0;
  let spawned = 0;
  const shots = new Set<number>();
  const statusSchema = z.object({ entityId: z.number(), entityStatus: z.number() });
  const status = (raw: unknown) => {
    const packet = statusSchema.safeParse(raw);
    if (packet.success && packet.data.entityId === bot.entity.id && packet.data.entityStatus === 29) blocks++;
  };
  const spawn: Parameters<typeof bot.on<"entitySpawn">>[1] = (entity) => {
    if (entity.name === "small_fireball") {
      shots.add(entity.id);
      spawned++;
    }
  };
  const gone: Parameters<typeof bot.on<"entityGone">>[1] = (entity) => {
    shots.delete(entity.id);
  };
  const tick = () => {
    log(
      `GUARD ${JSON.stringify({
        position: bot.entity.position,
        yaw: bot.entity.yaw,
        selected: incomingShieldProjectiles(bot)[0]?.id ?? null,
        projectiles: [...shots].map((id) => {
          const entity = bot.entities[id];
          return { id, position: entity?.position, velocity: entity?.velocity };
        }),
      })}`,
    );
  };
  bot._client.on("entity_status", status);
  bot.on("entitySpawn", spawn);
  bot.on("entityGone", gone);
  bot.on("physicsTick", tick);
  try {
    // Native small-fireball entities carry the two observed classes of speed.
    // The old distance rule faces east first, away from the faster southern shot.
    bot.chat("/summon small_fireball 0.5 -59 15.5 {Motion:[0.0d,0.0d,-0.821d]}");
    bot.chat("/summon small_fireball 9.5 -59 0.5 {Motion:[-0.1d,0.0d,0.0d]}");
    while (spawned < 2 || shots.size > 0) {
      signal.throwIfAborted();
      if (bot.health < 20) break;
      if (incomingShieldProjectiles(bot)[0]) {
        // Mine Labs owns the trial deadline and propagates its cancellation.
        await guardRetreatProjectiles(bot, navigation, signal, Infinity, DEFAULT_COMBAT_POLICY);
      } else await bot.waitForTicks(1);
    }
    // Closely spaced rejected hits need not each emit a shield status packet.
    // Require actual shield use and survival through a following burn tick,
    // rather than prescribing one status event per projectile.
    await bot.waitForTicks(25);
    return {
      status: spawned === 2 && blocks >= 1 && bot.health === 20 && shots.size === 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        spawned,
        blocks,
        health: bot.health,
        shieldWear: shield.durabilityUsed,
        remainingProjectiles: shots.size,
      }),
    };
  } finally {
    bot._client.off("entity_status", status);
    bot.off("entitySpawn", spawn);
    bot.off("entityGone", gone);
    bot.off("physicsTick", tick);
    bot.deactivateItem();
  }
};
