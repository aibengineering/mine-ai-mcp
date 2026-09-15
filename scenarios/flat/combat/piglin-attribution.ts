import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { readEncounters } from "./reflex.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
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
  const runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: "piglin-attribution", scope: { kind: "bot", botId: bot.username } },
    },
  });
  const started = Date.now();
  const record = (kind: string, value: unknown) => log(JSON.stringify({ ms: Date.now() - started, kind, value }));
  const damage = (packet: unknown) => record("damage_event", packet);
  let sourceLessHurt = false;
  let attributedBeforeResponse = false;
  const hurt: Parameters<typeof bot.on<"entityHurt">>[1] = (entity, source) => {
    if (entity?.id === bot.entity.id) {
      sourceLessHurt ||= source === undefined;
      attributedBeforeResponse ||= !responded && source?.name === "piglin";
    }
    record("entityHurt", {
      victim: entity?.id,
      source: source && { id: source.id, name: source.name, kind: source.kind, valid: source.isValid },
    });
  };
  const health = () => record("health", bot.health);
  const metadata: Parameters<typeof bot.on<"entityUpdate">>[1] = (entity) => {
    if (entity.name === "piglin") {
      const index = bot.registry.entitiesByName["piglin"]?.metadataKeys?.indexOf("mob_flags") ?? -1;
      const flags = index >= 0 ? entity.metadata[index] : undefined;
      aggressive ||= typeof flags === "number" && (flags & 4) !== 0;
    }
    if (entity.name === "piglin") record("piglinMetadata", { id: entity.id, metadata: entity.metadata });
  };
  let died = false;
  let deathPosition: typeof bot.entity.position | null = null;
  let aggressive = false;
  let responded = false;
  let responses = 0;
  const death = () => {
    died = true;
    deathPosition = bot.entity.position.clone();
    record("death", bot.health);
  };
  const controls = () =>
    Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((key) => [
        key,
        bot.getControlState(key),
      ]),
    );
  const body = () => ({
    bot: { position: bot.entity.position, width: bot.entity.width, height: bot.entity.height },
    controls: controls(),
    piglins: Object.values(bot.entities)
      .filter((entity) => entity.name === "piglin")
      .map((entity) => ({ id: entity.id, position: entity.position, width: entity.width, height: entity.height })),
  });
  const originalLookAt = bot.lookAt;
  bot.lookAt = async (point, force) => {
    if (Date.now() - started > 15_000) record("lookStart", { point, force, ...body() });
    await originalLookAt.call(bot, point, force);
    if (Date.now() - started > 15_000) record("lookEnd", { point, force, ...body() });
  };
  const originalWrite = bot._client.write;
  bot._client.write = (name, params) => {
    if (Date.now() - started > 15_000 && ["block_dig", "block_place", "use_item_on", "use_entity"].includes(name))
      record("outgoing", { name, params, ...body() });
    return originalWrite.call(bot._client, name, params);
  };
  const blockUpdate: Parameters<typeof bot.on<"blockUpdate">>[1] = (before, after) => {
    if (after && after.position.distanceTo(bot.entity.position) < 4)
      record("blockUpdate", { before: before?.name, after: after.name, position: after.position });
  };
  bot.on("blockUpdate", blockUpdate);
  bot.on("entityUpdate", metadata);
  bot.on("death", death);
  bot._client.on("damage_event", damage);
  bot.on("entityHurt", hurt);
  bot.on("health", health);
  try {
    bot.chat(
      '/summon minecraft:piglin 1.5 -60 0.5 {NoAI:1b,IsImmuneToZombification:1b,PersistenceRequired:1b,HandItems:[{id:"minecraft:golden_sword",count:1},{}]}',
    );
    await bot.waitForTicks(10);
    const piglin = Object.values(bot.entities).find((entity) => entity.name === "piglin");
    if (!piglin) throw new Error("Piglin not observed");
    record("identities", { bot: bot.entity.id, piglin: piglin.id });
    await bot.waitForTicks(20);
    const neutral = runtime.status().activeAction === null;
    bot.attack(piglin);
    bot.chat("/setblock 0 -60 0 minecraft:fire");
    await bot.waitForTicks(2);
    bot.chat("/data merge entity @e[type=minecraft:piglin,limit=1] {NoAI:0b}");
    let owner = "";
    // Observe a fixed pressure window. The response and its settlement are
    // telemetry; surviving the arranged overlapping damage is the verdict.
    for (let tick = 0; !died && tick < 400; tick++) {
      signal.throwIfAborted();
      if (Date.now() - started > 15_000 && tick % 5 === 0)
        record("body", {
          position: bot.entity.position,
          controls: controls(),
          piglin: piglin.position,
          held: bot.heldItem?.name,
        });
      await bot.waitForTicks(1);
      responded ||= aggressive && runtime.status().activeAction?.action === "hostile_reflex";
      const next = JSON.stringify(runtime.status().activeAction);
      if (owner !== next) {
        if (runtime.status().activeAction?.action === "hostile_reflex") responses++;
        owner = next;
        record("owner", runtime.status().activeAction);
      }
    }
    const distance = piglin.position.distanceTo(deathPosition ?? bot.entity.position);
    const encounters = await readEncounters(context, runtime);
    record("settledEvents", encounters);
    return {
      status: neutral && aggressive && sourceLessHurt && bot.health > 0 && !died ? "succeeded" : "failed",
      detail: JSON.stringify({
        neutral,
        aggressive,
        responded,
        responses,
        attributedBeforeResponse,
        encounters,
        distance,
        died,
        health: died ? 0 : bot.health,
      }),
    };
  } finally {
    bot.lookAt = originalLookAt;
    bot._client.write = originalWrite;
    bot.off("blockUpdate", blockUpdate);
    bot._client.off("damage_event", damage);
    bot.off("entityHurt", hurt);
    bot.off("health", health);
    bot.off("entityUpdate", metadata);
    bot.off("death", death);
    await runtime.close();
  }
};
