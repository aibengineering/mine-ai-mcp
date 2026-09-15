import { recordSourceIdentity } from "../../src/source-identity.ts";
import type { ClientCompletion } from 'mine-labs/client';
import { openRuntime, standStill } from '../../src/runtime.ts';
import type { MineAiScenarioContext } from '../../src/scenario-client.ts';
/** Baseline 96e0a60: the idle runtime has no damaging-fall detector or bucket rescue.
 * The platform is removed once. Physics, health, source and carried water are observed independently. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal, log } = context;
  await recordSourceIdentity();
  await standStill(context);
  const params = context.scenario.params as {
    storageWater?: boolean;
    impulse?: {
      x: number;
      y: number;
      z: number;
    };
    impulseWhenAirborne?: boolean;
    secondImpulse?: {
      x: number;
      y: number;
      z: number;
    };
    secondAt?: number;
  };
  if (params?.storageWater) {
    const bucket = bot.inventory.items().find(item => item.name === 'water_bucket')!;
    await bot.moveSlotItem(bucket.slot, 9);
    await bot.waitForTicks(2);
    if (bot.inventory.slots[9]?.name !== 'water_bucket') throw new Error('Storage bucket setup failed.');
    log('BUCKET_STORAGE_CONFIRMED slot9');
  }
  const runtime = await openRuntime(context, 'bucket-fall');
  const start = bot.entity.position.clone();
  let deaths = 0, ticks = 0, minimumHealth = bot.health, airborne = false, landed = false;
  let peakY = start.y, injected = false, secondInjected = false;
  const poured = new Set<string>();
  const removed = new Set<string>();
  const change = (before: ReturnType<typeof bot.blockAt>, after: ReturnType<typeof bot.blockAt>) => {
    if (!after)
      return;
    const key = after.position.toString();
    const isSource = after.name === "water" && Number(after.getProperties().level) === 0;
    if (isSource && before?.name !== "water")
      poured.add(key);
    if (poured.has(key) && !isSource)
      removed.add(key);
  };
  bot.on("blockUpdate", change);
  const frames: unknown[] = [];
  const death = () => { deaths++; minimumHealth = 0; };
  const tick = () => {
    ticks++;
    if (params?.impulseWhenAirborne && !injected && !bot.entity.onGround && params.impulse) {
      injected = true;
      bot._client.emit("entity_velocity", { entityId: bot.entity.id, velocity: params.impulse });
    }
    if (!secondInjected && params?.secondImpulse && ticks >= (params.secondAt ?? 20)) {
      secondInjected = true;
      bot._client.emit("entity_velocity", { entityId: bot.entity.id, velocity: params.secondImpulse });
    }
    minimumHealth = Math.min(minimumHealth, bot.health);
    peakY = Math.max(peakY, bot.entity.position.y);
    airborne ||= !bot.entity.onGround;
    landed ||= airborne && bot.entity.onGround && bot.entity.position.y < start.y - 2;
    const frame = { ticks, position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, ground: bot.entity.onGround,
      water: Reflect.get(bot.entity, 'isInWater'), health: bot.health, held: bot.heldItem?.name, owner: runtime.status().owner };
    frames.push(frame);
    log('BUCKET_TICK ' + JSON.stringify(frame));
  };
  bot.on('death', death);
  bot.on('physicsTick', tick);
  try {
    bot.chat(`/setblock ${Math.floor(start.x)} ${Math.floor(start.y) - 1} ${Math.floor(start.z)} air`);
    if (params?.impulse && !params.impulseWhenAirborne) {
      injected = true;
      bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: params.impulse });
    }
    while (ticks < 160 && deaths === 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    await runtime.captureIncident();
    const full = bot.inventory.items().filter(i => i.name === 'water_bucket').reduce((sum, i) => sum + i.count, 0);
    const detail = { deaths, minimumHealth, airborne, landed, peakY, full, poured: [...poured], removed: [...removed], injected, secondInjected, position: bot.entity.position };
    log('BUCKET_RESULT ' + JSON.stringify(detail));
    return { status: deaths === 0 && minimumHealth === 20 && landed && full === 1 && removed.size > 0 ? 'succeeded' : 'failed', detail: JSON.stringify(detail) };
  }
  finally {
    bot.off('blockUpdate', change);
    bot.off('death', death);
    bot.off('physicsTick', tick);
    await runtime.close();
  }
}
