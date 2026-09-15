import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import { entityMetadata } from "../../../src/world/end-fight.ts";
import type { BotEvents } from "mineflayer";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await wearArmor(context);
  await bot.equip(
    bot.inventory.items().find((i) => i.name === "carved_pumpkin")!,
    "head",
  );
  bot.chat('/summon zombie 3 -60 0 {NoAI:1b,Tags:["other_victim"]}');
  bot.chat("/attribute @e[tag=other_victim,limit=1] minecraft:max_health base set 200");
  bot.chat("/data merge entity @e[tag=other_victim,limit=1] {Health:200.0f}");
  bot.chat('/summon enderman 0 -60 0 {PersistenceRequired:1b,Tags:["target_test"]}');
  while (!bot.nearestEntity((e) => e.name === "enderman")) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  const enderman = bot.nearestEntity((e) => e.name === "enderman")!;
  await using runtime = await openRuntime(context, "enderman-other-target");
  const originalAttack = bot.attack;
  let attacks = 0,
    angryTicks = 0,
    takeoverTicks = 0,
    hurtByEnderman = false;
  bot.attack = (entity) => {
    attacks++;
    originalAttack.call(bot, entity);
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source?.id === enderman.id) hurtByEnderman = true;
  };
  bot.on("entityHurt", hurt);
  try {
    bot.chat("/gamemode survival");
    bot.chat("/damage @e[tag=target_test,limit=1] 1 minecraft:mob_attack by @e[tag=other_victim,limit=1]");
    for (let tick = 0; tick < 80; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
      if (entityMetadata(bot, enderman, "creepy") === true) angryTicks++;
      if (runtime.status().activeAction?.action === "hostile_reflex") takeoverTicks++;
    }
    const ignored = { angryTicks, attacks, takeoverTicks, health: bot.health, hurtByEnderman };
    log(`OTHER_TARGET ${JSON.stringify(ignored)}`);
    if (angryTicks < 20 || attacks !== 0 || hurtByEnderman)
      return { status: "failed", detail: JSON.stringify(ignored) };
    return { status: "succeeded", detail: JSON.stringify(ignored) };
  } finally {
    bot.attack = originalAttack;
    bot.off("entityHurt", hurt);
  }
};
