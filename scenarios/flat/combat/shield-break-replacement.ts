import { ScenarioCombat } from "../../src/combat.ts";
import { wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await wearArmor(context);
  // The carried fresh shield remains in inventory. Only the equipped shield
  // is worn by arrangement; subsequent damage and its destruction are native.
  bot.chat("/item replace entity @s weapon.offhand with minecraft:shield[minecraft:damage=335]");
  while (bot.inventory.slots[45]?.durabilityUsed !== 335) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  let broke = false;
  let replaced = false;
  let blocksAfter = 0;
  let shots = 0;
  const complete = new AbortController();
  const tick = () => {
    const shield = bot.inventory.slots[45];
    if (!shield || shield.name !== "shield") broke = true;
    if (broke && shield?.name === "shield" && shield.durabilityUsed < 335) replaced = true;
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (replaced && packet.entityId === bot.entity.id && packet.entityStatus === 29) {
      blocksAfter++;
      if (blocksAfter >= 2) complete.abort("Spare shield blocked two native attacks.");
    }
  };
  const spawn = (entity: typeof bot.entity) => {
    if (entity.name === "small_fireball") shots++;
  };
  bot.on("physicsTick", tick);
  bot.on("entitySpawn", spawn);
  bot._client.on("entity_status", status);
  try {
    bot.chat(
      '/summon blaze 12.5 -60 0.5 {PersistenceRequired:1b,Health:1024f,attributes:[{id:"minecraft:max_health",base:1024.0},{id:"minecraft:knockback_resistance",base:1.0}]}',
    );
    while (!bot.nearestEntity((e) => e.name === "blaze")) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const target = bot.nearestEntity((e) => e.name === "blaze")!;
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
const outcome = await scenarioCombat1.controller.engage(
      target.id,
      AbortSignal.any([signal, complete.signal]),
      "hold",
    );
    return {
      status: broke && replaced && blocksAfter >= 2 && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, broke, replaced, blocksAfter, shots, health: bot.health }),
    };
  } finally {
    bot.off("physicsTick", tick);
    bot.off("entitySpawn", spawn);
    bot._client.off("entity_status", status);
  }
};
