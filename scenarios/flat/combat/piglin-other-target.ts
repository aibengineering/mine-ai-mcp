import { createMinecraftRuntime, type MinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, signal, log }) => {
  const boots = bot.inventory.items().find((item) => item.name === "golden_boots");
  if (!boots) throw new Error("Gold boots missing");
  await bot.equip(boots, "feet");
  const record = (kind: string, value: unknown) => log(JSON.stringify({ kind, value }));
  let botHurt = false;
  let attacks = 0;
  let otherHit = false;
  let attackPackets = 0;
  const hurt: Parameters<typeof bot.on<"entityHurt">>[1] = (entity, source) => {
    if (entity.id === bot.entity.id) botHurt = true;
    if (entity.name === "hoglin" && source?.name === "piglin") otherHit = true;
    record("hurt", { victim: entity.id, source: source?.id, health: bot.health });
  };
  const originalWrite = bot._client.write;
  bot._client.write = function (name, data) {
    if (name === "use_entity" && data.mouse === 1) {
      attackPackets++;
      record("attackPacket", { target: data.target, botHurt, health: bot.health });
    }
    return originalWrite.call(bot._client, name, data);
  };
  const originalAttack = bot.attack;
  bot.attack = function (entity, ...args) {
    attacks++;
    record("botAttack", { target: entity.id, botHurt, health: bot.health });
    return originalAttack.call(bot, entity, ...args);
  };
  bot.on("entityHurt", hurt);
  let runtime: MinecraftRuntime | undefined;
  try {
    bot.chat(
      '/summon minecraft:hoglin 6.5 -60 0.5 {Tags:["other"],NoAI:1b,IsImmuneToZombification:1b,PersistenceRequired:1b}',
    );
    bot.chat(
      '/summon minecraft:piglin 3.5 -60 0.5 {Tags:["subject"],IsImmuneToZombification:1b,PersistenceRequired:1b,HandItems:[{id:"minecraft:golden_sword",count:1},{}]}',
    );
    await bot.waitForTicks(20);
    const piglin = bot.nearestEntity((entity) => entity.name === "piglin");
    const hoglin = bot.nearestEntity((entity) => entity.name === "hoglin");
    if (!piglin || !hoglin) throw new Error("Missing native entities");
    record("identities", { bot: bot.entity.id, piglin: piglin.id, hoglin: hoglin.id });
    bot.chat("/damage @e[tag=subject,limit=1] 1 minecraft:mob_attack by @e[tag=other,limit=1]");
    const index = bot.registry.entitiesByName["piglin"]?.metadataKeys?.indexOf("mob_flags") ?? -1;
    const aggressive = () => {
      const flags: unknown = index >= 0 ? piglin.metadata[index] : undefined;
      return typeof flags === "number" && (flags & 4) !== 0;
    };
    for (let tick = 0; tick < 80; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      if (aggressive() && otherHit) break;
    }
    record("beforeRuntime", { aggressive: aggressive(), otherHit, botHurt, attacks, health: bot.health });
    if (!aggressive() || !otherHit || botHurt || attacks || bot.health !== 20)
      throw new Error("Uninvolved aggressive control not established");
    // Keep the other target alive so quiet cannot be explained by the fight ending.
    bot.chat("/effect give @e[tag=other] minecraft:regeneration infinite 10 true");
    runtime = await createMinecraftRuntime(bot, {
      botData: {
        storage: { kind: "temporary" },
        identity: { worldId: "piglin-other-target", scope: { kind: "bot", botId: bot.username } },
      },
    });
    const takeovers = new Set<string>();
    let settledTicks = 0;
    for (let tick = 0; tick < 400 && settledTicks < 80; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      const action = runtime.status().activeAction;
      if (action?.action === "hostile_reflex") takeovers.add(action.startedAt);
      // Aggression toward the hoglin is not evidence of an attack on us.
      settledTicks = action === null && piglin.isValid && aggressive() && hoglin.isValid ? settledTicks + 1 : 0;
    }
    const evidence = {
      otherHit,
      attacks,
      attackPackets,
      botHurt,
      health: bot.health,
      takeovers: takeovers.size,
      settledTicks,
      aggressive: aggressive(),
      hoglinValid: hoglin.isValid,
      separation: piglin.position.distanceTo(bot.entity.position),
    };
    record("verdict", evidence);
    const succeeded =
      attacks === 0 &&
      attackPackets === 0 &&
      !botHurt &&
      bot.health === 20 &&
      settledTicks === 80 &&
      hoglin.isValid &&
      aggressive();
    return { status: succeeded ? "succeeded" : "failed", detail: JSON.stringify(evidence) };
  } finally {
    await runtime?.close();
    bot.attack = originalAttack;
    bot._client.write = originalWrite;
    bot.off("entityHurt", hurt);
  }
};
