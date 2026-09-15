import type { MineAiScenario } from '../../src/scenario-client.ts';
import { openRuntime, standStill } from '../../src/runtime.ts';
import { recordSourceIdentity } from '../../src/source-identity.ts';
import { Vec3 } from 'vec3';

/** Native integration e739f19 poured five ticks early; a second dragon launch stranded that source before contact. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal, log } = context;
  await standStill(context);
  const runtime = await openRuntime(context, 'bucket-followup-launch');
  const params = context.scenario.params as { secondAt?: number; requireReclaim?: boolean; requireAirborne?: boolean };
  let ticks = 0, airborneTicks = 0, deaths = 0, minimumHealth = bot.health;
  let sourceBeforeLaunch = false;
  let launchWhileDryAirborne = false;
  let launchIssued = false, originalBucketEmptied = false, originalBucketRefilled = false;
  let originalSourceAck: 'before_launch' | 'after_launch' | null = null;
  let heldAtLaunch: string | null = null;
  const originalSource = '(7, 82, 39)';
  const sources = new Set<string>(), removed = new Set<string>();
  const fullBuckets = () => bot.inventory.items().filter(item => item.name === 'water_bucket').reduce((n,item) => n + item.count, 0);
  const inventory = () => {
    const full = fullBuckets();
    if (full === 0 && !originalBucketRefilled) originalBucketEmptied = true;
    if (full === 1 && originalBucketEmptied && sources.has(originalSource)) originalBucketRefilled = true;
  };
  const death = () => { deaths++; minimumHealth = 0; };
  const change = (_before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (!after) return;
    const key = after.position.toString();
    const source = after.name === 'water' && Number(after.getProperties().level) === 0;
    if (source) {
      sources.add(key);
      if (key === originalSource && originalSourceAck === null) originalSourceAck = launchIssued ? 'after_launch' : 'before_launch';
    }
    if (sources.has(key) && !source) removed.add(key);
    inventory();
  };
  const tick = () => {
    ticks++;
    if (!bot.entity.onGround || airborneTicks > 0) airborneTicks++;
    if (airborneTicks === 1) bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: { x: -2, y: -2225, z: 616 } });
    // Fixed physics timing, independent of whether the implementation poured.
    if (airborneTicks === (params?.secondAt ?? 4)) {
      const source = bot.blockAt(new Vec3(7, 82, 39));
      sourceBeforeLaunch = source?.name === 'water' && Number(source.getProperties().level) === 0;
      heldAtLaunch = bot.heldItem?.name ?? null;
      launchWhileDryAirborne = !bot.entity.onGround && !Reflect.get(bot.entity, 'isInWater');
      launchIssued = true;
      bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: { x: -31200, y: 15294, z: -31200 } });
    }
    inventory();
    minimumHealth = Math.min(minimumHealth, bot.health);
    log('FOLLOWUP_TICK ' + JSON.stringify({ ticks, airborneTicks, p: bot.entity.position, v: bot.entity.velocity, ground: bot.entity.onGround, wet: Reflect.get(bot.entity, 'isInWater'), health: bot.health, held: bot.heldItem?.name }));
  };
  bot.on('death', death); bot.on('blockUpdate', change); bot.on('physicsTick', tick); bot.on('heldItemChanged', inventory);
  try {
    bot.chat('/setblock 7 84 38 air');
    while (ticks < 160 && deaths === 0) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    await runtime.captureIncident();
    const full = fullBuckets();
    const reclaimed = sources.has(originalSource) && removed.has(originalSource) && originalBucketRefilled;
    const finalSourceRecovered = [...sources].some(key => key !== originalSource && removed.has(key));
    const result = { deaths, minimumHealth, full, sourceBeforeLaunch, originalSourceAck, heldAtLaunch, originalBucketRefilled, launchWhileDryAirborne, reclaimed, finalSourceRecovered, sources: [...sources], removed: [...removed], end: bot.entity.position };
    log('FOLLOWUP_RESULT ' + JSON.stringify(result));
    return { status: deaths === 0 && minimumHealth === 20 && full === 1 && finalSourceRecovered && [...sources].every(key => removed.has(key)) && bot.entity.position.y === 63 && (!params?.requireReclaim || reclaimed) && (!params?.requireAirborne || launchWhileDryAirborne) ? 'succeeded' : 'failed', detail: JSON.stringify(result) };
  } finally {
    bot.off('death', death); bot.off('blockUpdate', change); bot.off('physicsTick', tick); bot.off('heldItemChanged', inventory);
    await runtime.close();
  }
};
