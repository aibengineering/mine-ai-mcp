import { z } from "zod";
import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import { isIncomingBlazeProjectile } from "../../../src/survival/perception/combat/blaze-projectiles.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, signal, scenario, log }) => {
  const params = z.object({ wounded: z.boolean().default(false) }).parse(scenario.params ?? {});
  for (const [name, slot] of [
    ["iron_helmet", "head"],
    ["iron_chestplate", "torso"],
    ["iron_leggings", "legs"],
    ["golden_boots", "feet"],
    ["shield", "off-hand"],
  ] as const) {
    const item = bot.inventory.items().find((item) => item.name === name);
    if (item) await bot.equip(item, slot);
  }
  if (params.wounded) {
    bot.chat("/attribute @s minecraft:max_health base set 11");
    await bot.waitForTicks(5);
  }

  const runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: "distant-attacker", scope: { kind: "bot", botId: bot.username } },
    },
  });
  let hit: { id: number; distance: number; health: number } | null = null;
  const hits: { distance: number; healthBefore: number }[] = [];
  let response = false;
  let responseBeforeHit = false;
  let shots = 0;
  let blocked = 0;
  let serverGuardedTicks = 0;
  let tick = 0;
  let claimedTick: number | null = null;
  let firstHitTick: number | null = null;
  const flightTimings = new Map<number, { spawnTick: number; incomingTick: number | null }>();
  const defense = () => ({
    tick,
    position: bot.entity.position.clone(),
    yaw: bot.entity.yaw,
    pitch: bot.entity.pitch,
    useFlags: bot.entity.metadata[useFlags],
    projectiles: Object.values(bot.entities)
      .filter((entity) => entity.name === "small_fireball")
      .map((entity) => ({
        id: entity.id,
        position: entity.position.clone(),
        velocity: entity.velocity.clone(),
        incoming: isIncomingBlazeProjectile(bot, entity),
      })),
  });
  let lastDefense: ReturnType<typeof defense> | null = null;
  const useFlags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const observeGuard = () => {
    tick++;
    lastDefense = defense();
    if (claimedTick === null && runtime.status().owner === "takeover") claimedTick = tick;
    for (const [id, timing] of flightTimings) {
      const entity = bot.entities[id];
      if (timing.incomingTick === null && entity && isIncomingBlazeProjectile(bot, entity)) timing.incomingTick = tick;
    }
    const flags: unknown = bot.entity.metadata[useFlags];
    if (runtime.status().activeAction?.action === "hostile_reflex" && typeof flags === "number" && (flags & 3) === 3)
      serverGuardedTicks++;
  };
  bot.on("physicsTick", observeGuard);
  let blazeDied = false;
  const shielded = bot.inventory.slots[45]?.name === "shield";
  const onHurt: Parameters<typeof bot.on<"entityHurt">>[1] = (entity, source) => {
    if (entity.id === bot.entity.id && source?.name === "blaze") {
      log(`BLAZE IMPACT ${JSON.stringify({ before: lastDefense, current: defense() })}`);
      firstHitTick ??= tick;
      const distance = source.position.distanceTo(bot.entity.position);
      hits.push({ distance, healthBefore: bot.health });
      hit ??= { id: source.id, distance, health: bot.health };
    }
  };
  bot.on("entityHurt", onHurt);
  const projectilePacket = (packet: { entityId: number; type: number; objectData: number }) => {
    if (bot.registry.entities[packet.type]?.name === "small_fireball") {
      shots++;
      flightTimings.set(packet.entityId, { spawnTick: tick, incomingTick: null });
      log(JSON.stringify({ projectileSpawn: packet }));
    }
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) blocked++;
  };
  const onDead: Parameters<typeof bot.on<"entityDead">>[1] = (entity) => {
    if (entity.name === "blaze") blazeDied = true;
  };
  bot._client.on("spawn_entity", projectilePacket);
  bot._client.on("entity_status", onStatus);
  bot.on("entityDead", onDead);
  try {
    // Keep native flight physics: NoGravity lets the blaze's idle upward
    // impulses accumulate until this horizontal-shot fixture becomes aerial.
    bot.chat("/summon minecraft:blaze 26.5 -60 0.5 {PersistenceRequired:1b}");
    // Observe the declared native threat for twenty seconds, regardless of the response chosen.
    for (let waited = 0; waited < 400 && bot.health > 0; waited++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      if (!response && runtime.status().activeAction?.action === "hostile_reflex") {
        response = true;
        responseBeforeHit = hit === null;
      }
    }
    const read = runtime.actions.find((action) => action.name === "read_recent_events");
    const events = read ? await runtime.run(read, {}, signal) : null;
    return {
      status: bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        shielded,
        hit,
        hits,
        response,
        responseBeforeHit,
        shots,
        blocked,
        serverGuardedTicks,
        latency: { claimedTick, firstHitTick, flights: [...flightTimings].map(([id, timing]) => ({ id, ...timing })) },
        blazeDied,
        health: bot.health,
        owner: runtime.status().activeAction,
        events,
      }),
    };
  } finally {
    bot._client.off("spawn_entity", projectilePacket);
    bot._client.off("entity_status", onStatus);
    bot.off("entityDead", onDead);
    bot.off("entityHurt", onHurt);
    bot.off("physicsTick", observeGuard);
    await runtime.close();
  }
};
