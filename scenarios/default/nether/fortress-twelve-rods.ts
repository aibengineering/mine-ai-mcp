import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import {
  declaredEntities,
  declaredEntitiesArranged,
  declaredStart,
  openRuntime,
  wearArmor,
} from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { observe } from "./hazards/pit.ts";
import { releaseThreats } from "./fortress-common.ts";
import { readEncounters } from "../../flat/combat/reflex.ts";
import { z } from "zod";
import { recordSourceIdentity } from "../../src/source-identity.ts";

const collectionSchema = z.strictObject({
  drops: z.number().int().positive().default(12),
  minimumDropsPerMinute: z.number().positive().optional(),
  camp_spawner: z.boolean().default(false),
  observe_for_ms: z.number().int().positive().default(720_000),
});

/** The driver supplies the task; all combat, recovery, and movement remain production actions. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const collection = collectionSchema.parse(context.scenario.params ?? {});
  const start = declaredStart(context);
  const spawner = new Vec3(-28, 82, 357);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  // Spectator inventory clicks are rejected by vanilla. Equip while still
  // in survival, then require the server's equipment slots before teleporting.
  await wearArmor(context);
  const boots = bot.inventory.slots[8]?.name;
  if (boots !== "diamond_boots" && boots !== "golden_boots") throw new Error("Unexpected fortress boots");
  let equipped = false;
  const confirm = (message: string) => {
    if (message === "FORTRESS_ARMOR_CONFIRMED") equipped = true;
  };
  bot.on("messagestr", confirm);
  try {
    bot.chat(
      `/execute if items entity @s armor.head diamond_helmet if items entity @s armor.chest diamond_chestplate if items entity @s armor.legs diamond_leggings if items entity @s armor.feet ${boots} run tellraw @s "FORTRESS_ARMOR_CONFIRMED"`,
    );
    await observe(bot, () => equipped, "server-confirmed expedition armour");
  } finally {
    bot.off("messagestr", confirm);
  }
  await bot.waitForChunksToLoad();
  if (bot.blockAt(spawner)?.name !== "spawner" || bot.blockAt(start.offset(0, -1, 0))?.name !== "nether_bricks")
    throw new Error("The surveyed live fortress spawner/floor changed.");
  for (const p of [start, start.offset(0, 1, 0)])
    if (bot.blockAt(p)?.boundingBox !== "empty") throw new Error(`Fortress starting body intersects ${p}.`);
  for (const { position } of declaredEntities(context)) {
    if ([position, position.offset(0, 1, 0)].some((cell) => bot.blockAt(cell)?.boundingBox !== "empty"))
      throw new Error(`Initial blaze body intersects generated terrain at ${position}.`);
  }
  await declaredEntitiesArranged(context);
  const rodId = bot.registry.itemsByName.blaze_rod!.id;
  if (bot.inventory.count(rodId, null) !== 0) throw new Error("Fortress hunt must start with no rods.");
  // Finish arrangement before attaching the runtime. Otherwise its idle
  // defence can claim the body while we await the native-AI acknowledgement,
  // and the single measured hunt is refused before it ever starts.
  await releaseThreats(context);
  const started = Date.now();
  const runtime = await openRuntime(context, "fortress-twelve-rods");
  let deaths = 0,
    minimumHealth = bot.health,
    shieldBlocks = 0,
    fireballs = 0,
    ticks = 0;
  let phase: unknown = null;
  const useFlags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const snapshot = () => ({
    ms: Date.now() - started,
    position: bot.entity.position.clone(),
    velocity: bot.entity.velocity.clone(),
    health: bot.health,
    food: bot.food,
    onGround: bot.entity.onGround,
    inLava: Reflect.get(bot.entity, "isInLava"),
    rods: bot.inventory.count(rodId, null),
    shield:
      bot.inventory.slots[45]?.name === "shield"
        ? {
            durabilityUsed: bot.inventory.slots[45].durabilityUsed,
            maxDurability: bot.inventory.slots[45].maxDurability,
          }
        : null,
    owner: runtime.status().activeAction?.action,
    supplies: bot.inventory
      .items()
      .filter((item) => ["cobblestone", "cooked_beef", "shield"].includes(item.name))
      .map((item) => ({ name: item.name, count: item.count, durabilityUsed: item.durabilityUsed })),
    held: bot.heldItem?.name,
    using: bot.usingHeldItem,
    useFlags: bot.entity.metadata[useFlags],
    yaw: bot.entity.yaw,
    controls: Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((key) => [
        key,
        bot.getControlState(key),
      ]),
    ),
    phase,
    spawner: bot.blockAt(spawner)?.name ?? null,
    threats: Object.values(bot.entities)
      .filter((e) => e.isValid && ["blaze", "small_fireball"].includes(e.name ?? ""))
      .map((e) => ({ id: e.id, name: e.name, position: e.position.clone(), velocity: e.velocity.clone() })),
  });
  const onDeath = () => {
    deaths++;
    log(`FORTRESS DEATH ${JSON.stringify(snapshot())}`);
    died.abort("fortress bot died");
  };
  const onHurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id) log(`FORTRESS HIT ${JSON.stringify({ ...snapshot(), source: source?.id })}`);
  };
  const onBlockUpdate: BotEvents["blockUpdate"] = (previous, current) => {
    if (previous?.position.equals(spawner) && previous.name === "spawner" && current?.name !== "spawner") {
      log(
        `FORTRESS SPAWNER LOST ${JSON.stringify({ previous: previous.name, current: current?.name, ...snapshot() })}`,
      );
    }
  };
  const onTick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    if (++ticks % 20 === 0) log(`FORTRESS BODY ${JSON.stringify(snapshot())}`);
  };
  const onSpawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "small_fireball") fireballs++;
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) shieldBlocks++;
  };
  const stopTrace = runtime.navigation.onEvent((event) => {
    if (["step_started", "step_phase", "step_failed", "run_settled"].includes(event.kind)) {
      phase = event;
      log(`FORTRESS NAV ${JSON.stringify(event)}`);
    }
  });
  bot.on("blockUpdate", onBlockUpdate);
  bot.on("death", onDeath);
  bot.on("entityHurt", onHurt);
  bot.on("physicsTick", onTick);
  bot.on("entitySpawn", onSpawn);
  bot._client.on("entity_status", onStatus);
  const attempts: unknown[] = [];
  try {
    const hunt = runtime.actions.find((a) => a.name === "collect_mob_drop")!;
    const result = await runtime.run(
      hunt,
      { mob_name: "blaze", drop_name: "blaze_rod", count: collection.drops, observe_for_ms: collection.observe_for_ms, camp_spawner: collection.camp_spawner },
      signal,
    );
    attempts.push(result);
    log(`FORTRESS HUNT ${JSON.stringify(result)}`);
    for (const encounter of await readEncounters(context, runtime))
      log(`FORTRESS ENCOUNTER ${JSON.stringify(encounter)}`);
    // Keep defence attached through a full native blaze charge and volley
    // after the last pickup, so delayed fire cannot turn a death into a pass.
    if (bot.inventory.count(rodId, null) >= collection.drops) await bot.waitForTicks(100);
    const elapsedMs = Date.now() - started;
    const gained = bot.inventory.count(rodId, null);
    const dropsPerMinute = (Math.min(gained, collection.drops) * 60_000) / elapsedMs;

    return {
      status:
        deaths === 0 &&
        bot.health > 0 &&
        gained >= collection.drops &&
        dropsPerMinute >= (collection.minimumDropsPerMinute ?? 0)
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        collection,
        elapsedMs,
        dropsPerMinute,
        huntSucceeded: result.result.status === "succeeded",
        deaths,
        minimumHealth,
        shieldBlocks,
        fireballs,
        final: snapshot(),
        attempts,
      }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return {
      status: "failed",
      detail: JSON.stringify({ deaths, minimumHealth, shieldBlocks, fireballs, final: snapshot(), attempts }),
    };
  } finally {
    log(`FORTRESS FINAL ${JSON.stringify({ deaths, minimumHealth, shieldBlocks, fireballs, final: snapshot() })}`);
    stopTrace();
    bot.off("blockUpdate", onBlockUpdate);
    bot.off("death", onDeath);
    bot.off("entityHurt", onHurt);
    bot.off("physicsTick", onTick);
    bot.off("entitySpawn", onSpawn);
    bot._client.off("entity_status", onStatus);
    await runtime.close();
  }
};
