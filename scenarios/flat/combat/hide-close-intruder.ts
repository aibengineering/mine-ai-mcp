import { Vec3 } from "vec3";
import { hideInPlace } from "../../../src/survival/responses/hide.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async ({ bot, navigation, scenario, signal, log }) => {
  const neutral = scenario.name?.endsWith("neutral");
  const species = neutral ? "piglin" : "wither_skeleton";
  for (const [name, slot] of [
    ["iron_helmet", "head"],
    ["iron_chestplate", "torso"],
    ["iron_leggings", "legs"],
    ["golden_boots", "feet"],
    ["shield", "off-hand"],
  ] as const) {
    const item = bot.inventory.items().find((item) => item.name === name);
    if (!item) throw new Error(`Missing ${name}`);
    await bot.equip(item, slot);
  }
  const equipment = neutral ? "" : ',HandItems:[{id:"minecraft:stone_sword",count:1},{}]';
  bot.chat(`/summon minecraft:${species} 0.5 -60 -0.1 {NoAI:1b,PersistenceRequired:1b${equipment}}`);
  await bot.waitForTicks(10);
  bot.chat("/damage @s 12.4 minecraft:magic");
  for (let tick = 0; tick < 20 && bot.health > 8; tick++) await bot.waitForTicks(1);
  const mob = bot.nearestEntity((entity) => entity.name === species);
  if (!mob || bot.health > 8) throw new Error("Low-health intruder arrangement was not observed");
  const observedWeapon = mob.equipment[0]?.name ?? null;
  if (!neutral && observedWeapon !== "stone_sword")
    throw new Error(`Attacker stone sword not observed: ${observedWeapon}`);
  log(JSON.stringify({ kind: "arranged", mobId: mob.id, observedWeapon, health: bot.health }));
  const started = Date.now();
  const abort = new AbortController();
  let died = false;
  let attacks = 0;
  const write = bot._client.write;
  bot._client.write = function (name, data) {
    if (name === "block_place" || name === "held_item_slot")
      log(
        JSON.stringify({
          kind: name,
          ms: Date.now() - started,
          data,
          held: bot.heldItem?.name,
          count: bot.heldItem?.count,
          quickBarSlot: bot.quickBarSlot,
          bot: bot.entity.position,
          mob: mob.position,
        }),
      );
    return write.call(bot._client, name, data);
  };
  const attack = bot.attack;
  bot.attack = function (entity, ...args) {
    attacks++;
    return attack.call(bot, entity, ...args);
  };
  const onDeath = () => {
    died = true;
    abort.abort(new Error("fixture death"));
  };
  bot.on("death", onDeath);
  if (!neutral) bot.chat(`/data merge entity @e[type=minecraft:${species},limit=1] {NoAI:0b}`);
  try {
    using responseOwner1 = new ScenarioCombat(bot, navigation);
    const result = await hideInPlace(bot, {
      signal: AbortSignal.any([signal, abort.signal]),
      recoverTo: 18,
      maximumMs: 1000,
      threatContext: {
        ...responseOwner1.context,
        resolvedIds: new Set(),
        attackerIds: new Set(),
        unreachableIds: new Set(),
      },
    });
    const feet = bot.entity.position.floored();
    const cells = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      .flatMap((side) => [feet.plus(side), feet.plus(side).offset(0, 1, 0)])
      .concat(feet.offset(0, 2, 0));
    const openCells = cells.filter((cell) => bot.blockAt(cell)?.boundingBox !== "block");
    for (let tick = 0; tick < 80 && !died; tick++) await bot.waitForTicks(1);
    const passed =
      !died &&
      (neutral
        ? attacks === 0 &&
          result.kind === "failed" &&
          /still open.*overlaps piglin/.test(result.error ?? "") &&
          [new Vec3(0, -60, -1), new Vec3(0, -59, -1)].every((cell) => openCells.some((open) => open.equals(cell)))
        : attacks > 0 && result.kind !== "failed" && openCells.length === 0);
    const evidence = {
      observedWeapon,
      result,
      died,
      attacks,
      health: bot.health,
      openCells,
      durationMs: Date.now() - started,
    };
    log(JSON.stringify(evidence));
    return { status: passed ? "succeeded" : "failed", detail: JSON.stringify(evidence) };
  } finally {
    bot._client.write = write;
    bot.attack = attack;
    bot.off("death", onDeath);
  }
};
