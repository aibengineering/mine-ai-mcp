import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

/** The saved incident's two-block feet offset, with native motion during the first swing. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) return { status: "failed", detail: "Player did not settle." };
  await wearArmor(context);
  const sword = bot.inventory.items().find((item) => item.name === "iron_sword")!;
  await bot.equip(sword, "hand");
  await bot.waitForTicks(20);
  bot.chat(
    '/summon minecraft:enderman 0.40042749549792 -59 2.29414146421686 {NoAI:1b,PersistenceRequired:1b,Tags:["sweep_target"]}',
  );
  bot.chat(
    '/summon minecraft:enderman -0.35782765833365 -58 2.620312386678384 {NoAI:1b,PersistenceRequired:1b,Tags:["sweep_bystander"]}',
  );
  while (Object.values(bot.entities).filter((entity) => entity.name === "enderman").length < 2) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  const endermen = Object.values(bot.entities).filter((entity) => entity.name === "enderman");
  const target = endermen.find((entity) => entity.position.y < -58.5)!;
  const bystander = endermen.find((entity) => entity.id !== target.id)!;
  const healthIndex = bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("health");
  const health = () => {
    const value: unknown = bystander.metadata[healthIndex];
    return typeof value === "number" ? value : null;
  };
  const stop = new AbortController();
  const hits: { victim: number; source: number | null }[] = [];
  const packets: unknown[] = [];
  const swings: unknown[] = [];
  const onDamage = (packet: unknown) => {
    packets.push(packet);
  };
  const onHurt: BotEvents["entityHurt"] = (entity, source) => {
    hits.push({ victim: entity.id, source: source?.id ?? null });
    if (entity.id === target.id) stop.abort("Observed the requested first target hit");
  };
  const originalAttack = bot.attack;
  bot.attack = (entity) => {
    swings.push({
      target: entity.id,
      weapon: bot.heldItem?.name,
      bot: bot.entity.position.clone(),
      targetPosition: target.position.clone(),
      bystander: bystander.position.clone(),
      feetDistance: bystander.position.distanceTo(bot.entity.position),
    });
    originalAttack.call(bot, entity);
  };
  bot.on("entityHurt", onHurt);
  bot._client.on("damage_event", onDamage);
  try {
    // Arrangement ends at this acknowledged release; no combat owner existed while NoAI was set.
    let acknowledge!: () => void;
    let rejectRelease!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      rejectRelease = () => reject(signal.reason);
    });
    const message: BotEvents["messagestr"] = (text) => {
      if (text.includes("sweep_native_ready")) acknowledge();
    };
    bot.on("messagestr", message);
    signal.addEventListener("abort", rejectRelease, { once: true });
    try {
      signal.throwIfAborted();
      bot.chat("/data merge entity @e[tag=sweep_target,limit=1] {NoAI:0b}");
      bot.chat(
        "/data merge entity @e[tag=sweep_bystander,limit=1] {NoAI:0b,Motion:[0.2470703125d,0.0d,-0.5732421875d]}",
      );
      bot.chat("/say sweep_native_ready");
      await ready;
    } finally {
      bot.off("messagestr", message);
      signal.removeEventListener("abort", rejectRelease);
    }
    const before = {
      health: health(),
      bot: bot.entity.position.clone(),
      target: target.position.clone(),
      bystander: bystander.position.clone(),
    };
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const outcome = await scenarioCombat1.controller.engage(
      target.id,
      AbortSignal.any([signal, stop.signal]),
      "pursue",
    );
    await bot.waitForTicks(20);
    const evidence = {
      botId: bot.entity.id,
      targetId: target.id,
      bystanderId: bystander.id,
      before,
      bystanderPosition: bystander.position,
      bystanderHealth: health(),
      hits,
      packets,
      swings,
      outcome,
      health: bot.health,
    };
    const evidenceFile = await writeScenarioEvidence(context, "enderman-bystander.json", evidence);
    return {
      status:
        hits.some((hit) => hit.victim === target.id && hit.source === bot.entity.id) &&
        !hits.some((hit) => hit.victim === bystander.id) &&
        bystander.position.distanceTo(before.bystander) > 0 &&
        health() === 40
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        targetId: target.id,
        bystanderId: bystander.id,
        targetHit: hits.some((hit) => hit.victim === target.id && hit.source === bot.entity.id),
        bystanderHit: hits.some((hit) => hit.victim === bystander.id),
        bystanderMoved: bystander.position.distanceTo(before.bystander) > 0,
        bystanderHealth: health(),
        outcome: outcome.kind,
        weaponsUsed: outcome.weaponsUsed,
        health: bot.health,
        evidenceFile,
      }),
    };
  } finally {
    bot.attack = originalAttack;
    bot.off("entityHurt", onHurt);
    bot._client.off("damage_event", onDamage);
  }
};
