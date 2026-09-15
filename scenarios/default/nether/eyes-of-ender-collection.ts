import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { declaredEntitiesArranged, openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { observe } from "./hazards/pit.ts";
import { releaseThreats } from "./fortress-common.ts";

const position = z.tuple([z.number(), z.number(), z.number()]);
const paramsSchema = z.strictObject({ ender_start: position });

/**
 * Collect a full set of eye ingredients and craft them through production actions.
 *
 * The fortress start and its initial blazes are the scenario file's; the
 * pearl phase moves the opped bot to a second site.
 * Every kill, pickup and craft is a production
 * action: `collect_mob_drop` fights blazes and endermen through the same combat
 * controller the reflex uses, and `craft_item` plans the eye tree from
 * the carried rods and pearls.
 */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const ender = new Vec3(...params.ender_start);
  const rodId = bot.registry.itemsByName.blaze_rod!.id;
  const pearlId = bot.registry.itemsByName.ender_pearl!.id;
  const eyeId = bot.registry.itemsByName.ender_eye!.id;
  const died = new AbortController();
  const runSignal = AbortSignal.any([signal, died.signal]);

  let deaths = 0;
  let minimumHealth = 20;
  let phase: "blazes" | "endermen" | "crafting" = "blazes";
  let maximumRods = 0;
  let maximumPearls = 0;
  let endermanPopulationActive = false;
  let replenishEndermen = false;
  const onDeath = () => {
    log(`EYES DEATH ${JSON.stringify({ phase, maximumRods, maximumPearls, position: bot.entity.position })}`);
    deaths++;
    died.abort("bot died");
  };
  const onTick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    maximumRods = Math.max(maximumRods, bot.inventory.count(rodId, null));
    maximumPearls = Math.max(maximumPearls, bot.inventory.count(pearlId, null));
    if (
      endermanPopulationActive &&
      !replenishEndermen &&
      !Object.values(bot.entities).some((entity) => entity.isValid && entity.name === "enderman")
    ) {
      replenishEndermen = true;
      bot.chat(`/summon enderman ${ender.x + 4} ${ender.y} ${ender.z} {PersistenceRequired:1b}`);
    }
  };
  const onSpawn = (entity: Bot["entity"]) => {
    if (endermanPopulationActive && entity.name === "enderman") replenishEndermen = false;
  };
  bot.on("death", onDeath);
  bot.on("physicsTick", onTick);
  bot.on("entitySpawn", onSpawn);

  await wearArmor(context);
  // Complete arrangement before idle defence can claim the body. The former
  // ordering awaited chunk/entity setup with the runtime already active, then
  // received ACTION_BUSY without ever admitting the collection request.
  await bot.waitForChunksToLoad();
  await declaredEntitiesArranged(context);
  await releaseThreats(context);

  const runtime = await openRuntime(context, "eyes-of-ender-collection");
  const hunt = () => runtime.actions.find((a) => a.name === "collect_mob_drop")!;
  const craft = () => runtime.actions.find((a) => a.name === "craft_item")!;

  try {
    // ---- Phase 1: blaze rods at the fortress spawner ----
    // Six rods yield twelve blaze powder, enough for twelve eyes.
    const blazeHunt = await runtime.run(
      hunt(),
      { mob_name: "blaze", drop_name: "blaze_rod", count: 6, observe_for_ms: 720_000 },
      runSignal,
    );
    log(`EYES BLAZE ${JSON.stringify(blazeHunt.result)}`);
    const rodsCollected = bot.inventory.count(rodId, null);
    log(`EYES RODS ${rodsCollected}`);
    if (rodsCollected < 6) {
      return {
        status: "failed",
        detail: JSON.stringify({ phase, reason: "rod quota unmet", rods: rodsCollected, deaths, minimumHealth }),
      };
    }

    // ---- Phase 2: ender pearls at a separate arranged site ----
    bot.chat("/gamemode spectator");
    await observe(bot, () => bot.game.gameMode === "spectator", "spectator 2");
    bot.chat(`/execute in minecraft:the_nether run tp @s ${ender.x} ${ender.y} ${ender.z}`);
    await observe(bot, () => bot.entity.position.distanceTo(ender.offset(0.5, 0, 0.5)) < 3, "ender start");
    await bot.waitForChunksToLoad();
    // A flat open arena gives native endermen valid standing and teleport cells.
    const fx = Math.floor(ender.x),
      fy = ender.y,
      fz = Math.floor(ender.z);
    const fills = [
      `fill ${fx - 6} ${fy - 1} ${fz - 6} ${fx + 6} ${fy - 1} ${fz + 6} nether_bricks`,
      `fill ${fx - 6} ${fy} ${fz - 6} ${fx + 6} ${fy + 3} ${fz + 6} air`,
    ];
    for (const f of fills) bot.chat(`/execute in minecraft:the_nether run ${f}`);
    await bot.waitForTicks(10);
    bot.chat("/gamemode survival");
    await observe(bot, () => bot.game.gameMode === "survival", "survival for enderman combat");

    bot.chat(`/summon enderman ${fx + 4}.5 ${fy} ${fz}.5 {PersistenceRequired:1b}`);
    await observe(bot, () => Object.values(bot.entities).some((e) => e.isValid && e.name === "enderman"), "enderman");
    phase = "endermen";
    endermanPopulationActive = true;
    const endermanHunt = await runtime.run(
      hunt(),
      { mob_name: "enderman", drop_name: "ender_pearl", count: 12, observe_for_ms: 720_000 },
      runSignal,
    );
    endermanPopulationActive = false;
    log(`EYES ENDER ${JSON.stringify(endermanHunt.result)}`);
    const pearlsCollected = bot.inventory.count(pearlId, null);
    log(`EYES PEARLS ${pearlsCollected}`);
    if (pearlsCollected < 12) {
      return {
        status: "failed",
        detail: JSON.stringify({
          phase,
          reason: "pearl quota unmet",
          rods: rodsCollected,
          pearls: pearlsCollected,
          deaths,
          minimumHealth,
        }),
      };
    }

    // ---- Phase 3: craft twelve eyes ----
    phase = "crafting";
    const eyeCraft = await runtime.run(craft(), { items: [{ item_name: "ender_eye", count: 12 }] }, runSignal);
    log(`EYES CRAFT ${JSON.stringify(eyeCraft.result)}`);

    const eyes = bot.inventory.count(eyeId, null);
    const rods = bot.inventory.count(rodId, null);
    const pearls = bot.inventory.count(pearlId, null);
    return {
      status: eyes >= 12 && deaths === 0 && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ eyes, rods, pearls, deaths, minimumHealth, health: bot.health }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return {
      status: "failed",
      detail: JSON.stringify({
        eyes: bot.inventory.count(eyeId, null),
        rods: bot.inventory.count(rodId, null),
        pearls: bot.inventory.count(pearlId, null),
        deaths,
        minimumHealth,
        phase,
        maximumRods,
        maximumPearls,
      }),
    };
  } finally {
    endermanPopulationActive = false;
    bot.off("death", onDeath);
    bot.off("physicsTick", onTick);
    bot.off("entitySpawn", onSpawn);
    await runtime.close();
  }
};
