import type { MineAiScenario, MineAiScenarioPreparation } from '../../src/scenario-client.ts';
import { openRuntime, wearArmor } from '../../src/runtime.ts';
import { recordSourceIdentity } from '../../src/source-identity.ts';
/** Isolated End geometry. A native TNT blast supplies the knockback; the driver never sets velocity or pours water. */
export const prepare: MineAiScenarioPreparation = async (context) => {
  const { bot } = context;
  await wearArmor(context);
  bot.chat('/kill @e[type=ender_dragon]');
  bot.chat('/kill @e[type=enderman]');
  bot.chat('/fill 65 58 -16 100 115 16 air');
  bot.chat('/fill 65 58 -16 100 58 16 end_stone');
  bot.chat('/setblock 76 99 0 glass');
  bot.chat('/setblock 79 99 0 glass');
  bot.chat('/tp @s 79.5 100 0.5');
  await bot.waitForTicks(10);
};
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal, log } = context;
  const runtime = await openRuntime(context, 'bucket-native-end');
  let deaths = 0, ticks = 0, airborne = false, landed = false, minimumHealth = bot.health;
  const damages: unknown[] = [];
  let fallHits = 0, explosions = 0;
  const sources = new Set<string>(), removed = new Set<string>();
  const death = () => { deaths++; };
  const damage = (p: {
    entityId: number;
    sourceTypeId: number;
  }) => { if (p.entityId !== bot.entity.id)
    return; damages.push(p); if (p.sourceTypeId === 10)
    fallHits++; };
  const explosion = (packet: unknown) => { explosions++; log('NATIVE_EXPLOSION ' + JSON.stringify(packet)); };
  const change = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => { if (!after)
    return; const key = after.position.toString(); const source = after.name === 'water' && Number(after.getProperties().level) === 0; if (source && before?.name !== 'water')
    sources.add(key); if (sources.has(key) && !source)
    removed.add(key); };
  const tick = () => { ticks++; minimumHealth = Math.min(minimumHealth, bot.health); airborne ||= !bot.entity.onGround; landed ||= airborne && bot.entity.onGround && bot.entity.position.y < 90; log('NATIVE_BUCKET_TICK ' + JSON.stringify({ ticks, p: bot.entity.position, v: bot.entity.velocity, health: bot.health, held: bot.heldItem?.name })); };
  bot.on('death', death);
  bot.on('physicsTick', tick);
  bot.on('blockUpdate', change);
  bot._client.on('damage_event', damage);
  bot._client.on('explosion', explosion);
  try {
    bot.chat('/summon tnt 76.5 100 0.5 {fuse:20}');
    while (ticks < 200 && deaths === 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await runtime.captureIncident();
    const full = bot.inventory.items().filter(i => i.name === 'water_bucket').reduce((n, i) => n + i.count, 0);
    const evidence = { deaths, explosions, fallHits, minimumHealth, airborne, landed, full, sources: [...sources], removed: [...removed], damages, position: bot.entity.position, dimension: bot.game.dimension };
    log('NATIVE_BUCKET_RESULT ' + JSON.stringify(evidence));
    return { status: deaths === 0 && explosions > 0 && fallHits === 0 && landed && full === 1 && removed.size > 0 ? 'succeeded' : 'failed', detail: JSON.stringify(evidence) };
  }
  finally {
    bot.off('death', death);
    bot.off('physicsTick', tick);
    bot.off('blockUpdate', change);
    bot._client.off('damage_event', damage);
    bot._client.off('explosion', explosion);
    await runtime.close();
  }
};
