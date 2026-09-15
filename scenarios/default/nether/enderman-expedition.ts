import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { droppedItemName } from "../../../src/world/item-pickup.ts";
import {
  declaredEntities,
  declaredEntitiesArranged,
  declaredStart,
  openRuntime,
  standStill,
  wearArmor,
} from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";

const position = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const damageEventSchema = z.object({
  entityId: z.number(),
  sourceCauseId: z.number(),
  sourceDirectId: z.number(),
});
const paramsSchema = z.strictObject({
  approach: position,
  collection: z
    .strictObject({
      drops: z.number().int().positive(),
      minimumDropsPerMinute: z.number().positive(),
    })
    .optional(),
});

/** Arrangement commands must visibly settle before the measured expedition begins. */
async function arranged(bot: Bot, fact: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 400; tick++) {
    if (fact()) return;
    await bot.waitForTicks(1);
  }
  throw new Error(`Arrangement did not observe ${label} within 20 seconds.`);
}

/** Native combat, loot and the return journey are all owned by ordinary production actions. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const params = paramsSchema.parse(context.scenario.params);
  const start = declaredStart(context);
  const home = start.floored();
  const endermen = declaredEntities(context).filter(({ name }) => name === "enderman");
  await bot.waitForChunksToLoad();
  for (const [x, y, z] of [
    home.toArray(),
    params.approach,
    ...endermen.map(({ position }) => position.floored().toArray()),
  ]) {
    const feet = new Vec3(x, y, z);
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    if (
      floor?.boundingBox !== "block" ||
      bot.blockAt(feet)?.boundingBox !== "empty" ||
      bot.blockAt(feet.offset(0, 1, 0))?.boundingBox !== "empty"
    )
      throw new Error(`Surveyed standing cell changed at ${feet}.`);
    log(`survey ${feet}: floor ${floor.name}, roof ${bot.blockAt(feet.offset(0, 2, 0))?.name}`);
  }
  if (!(await standStill(context))) throw new Error("The expedition did not settle on its surveyed starting cell.");
  await wearArmor(context);
  // Spectator inventory clicks were rejected by the server in the first batch.
  // This native command observes all four server equipment slots before any mob is summoned.
  let equipmentConfirmed = false;
  const onEquipment = (message: string) => {
    if (message === "ENDER_EXPEDITION_ARMOR_CONFIRMED") equipmentConfirmed = true;
  };
  bot.on("messagestr", onEquipment);
  try {
    bot.chat(
      '/execute if items entity @s armor.head minecraft:iron_helmet if items entity @s armor.chest minecraft:iron_chestplate if items entity @s armor.legs minecraft:iron_leggings if items entity @s armor.feet minecraft:golden_boots run tellraw @s "ENDER_EXPEDITION_ARMOR_CONFIRMED"',
    );
    await arranged(bot, () => equipmentConfirmed, "server-confirmed expedition armor in all four slots");
  } finally {
    bot.off("messagestr", onEquipment);
  }
  log("Server confirmed iron helmet, chestplate, leggings and golden boots equipped before native mob arrangement.");
  for (const { position } of endermen) {
    if (bot.blockAt(position.floored().offset(0, 2, 0))?.name !== "air")
      throw new Error(`Enderman lacks its third clear body block at ${position}.`);
  }
  await declaredEntitiesArranged(context);

  const pearlId = bot.registry.itemsByName.ender_pearl!.id;
  const targetIds = new Set(
    Object.values(bot.entities)
      .filter((entity) => entity.name === "enderman")
      .map((entity) => entity.id),
  );
  const arrowId = bot.registry.itemsByName.arrow!.id;
  const initialPearls = bot.inventory.count(pearlId, null);
  const initialArrows = bot.inventory.count(arrowId, null);
  let minimumHealth = bot.health;
  let minimumArrows = initialArrows;
  let collecting = false;
  let replenishing = false;
  let deaths = 0;
  let targetDeaths = 0;
  let nativeTargetHits = 0;
  let largeTargetDisplacements = 0;
  let maximumDistanceFromHome = 0;
  const lastPositions = new Map<number, Vec3>();
  const pearlDrops = new Set<number>();
  const onDead = (entity: Bot["entity"]) => {
    if (targetIds.has(entity.id)) targetDeaths++;
  };
  const onDeath = () => {
    deaths++;
    died.abort("Enderman expedition bot died");
  };
  const onSpawn = (entity: Bot["entity"]) => {
    if (entity.name === "enderman") {
      targetIds.add(entity.id);
      replenishing = false;
    }
  };
  const onTick = () => {
    // Native population is fixture arrangement, independent of health, tactics and request boundaries.
    if (
      params.collection &&
      collecting &&
      !replenishing &&
      !Object.values(bot.entities).some((entity) => entity.isValid && entity.name === "enderman")
    ) {
      replenishing = true;
      for (const { position } of endermen)
        bot.chat(`/summon minecraft:enderman ${position.x} ${position.y} ${position.z} {PersistenceRequired:1b}`);
      log("Replenishing exhausted native endermen; health and loot remain native.");
    }
    minimumHealth = Math.min(minimumHealth, bot.health);
    minimumArrows = Math.min(minimumArrows, bot.inventory.count(arrowId, null));
    maximumDistanceFromHome = Math.max(maximumDistanceFromHome, bot.entity.position.distanceTo(start));
    for (const entity of Object.values(bot.entities)) {
      if (droppedItemName(entity) === "ender_pearl") pearlDrops.add(entity.id);
    }
  };
  const onMoved = (entity: Bot["entity"]) => {
    if (entity.name !== "enderman") return;
    const before = lastPositions.get(entity.id);
    if (before && before.distanceTo(entity.position) > 4) largeTargetDisplacements++;
    lastPositions.set(entity.id, entity.position.clone());
  };
  bot.on("entityDead", onDead);
  bot.on("death", onDeath);
  bot.on("physicsTick", onTick);
  bot.on("entityMoved", onMoved);
  bot.on("entitySpawn", onSpawn);
  try {
    const runtime = await openRuntime(context, "seeded-nether-enderman");
    // A hunt can outlast the incident recorder's twenty-second history. Save
    // native hits as they happen so shield readiness before the first hit is
    // still available after a later shelter/return failure.
    const captureHit = (packet: unknown) => {
      const parsed = damageEventSchema.safeParse(packet);
      if (!parsed.success) return;
      const hit = parsed.data;
      // Damage source IDs encode the entity ID plus one; zero means no entity.
      // Count the whole expedition, including hits delivered by the hostile reflex.
      if (
        targetIds.has(hit.entityId) &&
        (hit.sourceCauseId === bot.entity.id + 1 || hit.sourceDirectId === bot.entity.id + 1)
      )
        nativeTargetHits++;
      if (hit.entityId !== bot.entity.id) return;
      void runtime.captureIncident().catch((cause) => log(`Incident capture failed: ${String(cause)}`));
    };
    bot._client.on("damage_event", captureHit);
    const actions: { name: string; output: unknown }[] = [];
    const call = async (name: string, request: unknown) => {
      const action = runtime.actions.find((candidate) => candidate.name === name);
      if (!action) throw new Error(`Missing production action ${name}.`);
      const output = await runtime.run(action, request, signal);
      actions.push({ name, output });
      log(`${name}: ${JSON.stringify(output)}`);
      await runtime.captureIncident();
      return output;
    };
    try {
      // The collection variant replenishes only an exhausted target population;
      // terrain, native health and loot stay unchanged throughout the trip.
      const started = Date.now();
      const [x, y, z] = params.approach;
      const outward = await call("navigate", { x, y, z, range: 1, dig: false, scaffold: false });
      const requested = params.collection?.drops ?? 1;
      collecting = true;
      const hunting =
        outward.result.status === "succeeded"
          ? await call("collect_mob_drop", { mob_name: "enderman", drop_name: "ender_pearl", count: requested })
          : null;
      collecting = false;
      const returning = await call("navigate", {
        x: home.x,
        y: home.y,
        z: home.z,
        range: 1,
      });
      // Keep the reflex attached through five seconds of post-return damage and delayed contact.
      await bot.waitForTicks(100);
      const gained = bot.inventory.count(pearlId, null) - initialPearls;
      const elapsedMs = Date.now() - started;
      const dropsPerMinute = (Math.min(gained, requested) * 60_000) / elapsedMs;
      const remaining = bot.entity.position.distanceTo(start);
      const passed =
        initialPearls === 0 &&
        gained >= requested &&
        dropsPerMinute >= (params.collection?.minimumDropsPerMinute ?? 0) &&
        deaths === 0 &&
        bot.health > 0 &&
        bot.game.dimension === "the_nether" &&
        remaining <= 2;
      const detail = JSON.stringify({
        seed: 20260906,
        home,
        approach: params.approach,
        dimension: bot.game.dimension,
        gained,
        collection: params.collection,
        hunting,
        returning,
        elapsedMs,
        dropsPerMinute,
        nativePearlDropsObserved: pearlDrops.size,
        targetDeaths,
        nativeTargetHits,
        deaths,
        minimumHealth,
        finalHealth: bot.health,
        arrowInventory: {
          initial: initialArrows,
          minimum: minimumArrows,
          final: bot.inventory.count(arrowId, null),
          netLoss: initialArrows - bot.inventory.count(arrowId, null),
          deathObserved: deaths > 0,
        },
        largeTargetDisplacements,
        maximumDistanceFromHome,
        remaining,
        actions,
        verdict: passed
          ? "pearl returned alive"
          : gained === 0 && targetDeaths > 0 && pearlDrops.size === 0
            ? "no native pearl observed; expedition incomplete"
            : "expedition incomplete",
      });
      return { status: passed ? "succeeded" : "failed", detail };
    } finally {
      collecting = false;
      bot._client.off("damage_event", captureHit);
      await runtime.close();
    }
  } finally {
    bot.off("entityDead", onDead);
    bot.off("death", onDeath);
    bot.off("physicsTick", onTick);
    bot.off("entityMoved", onMoved);
    bot.off("entitySpawn", onSpawn);
  }
};
