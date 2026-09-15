import { Vec3 } from 'vec3';
import type { MineAiScenario } from '../../src/scenario-client.ts';
import { recordSourceIdentity } from '../../src/source-identity.ts';
import { bucketAvailable, predictWaterLanding, saveWaterLanding, waterableLanding } from '../../../src/navigation/mineflayer/water-landing.ts';
import { observeMineflayerBlock } from '../../../src/navigation/mineflayer/world.ts';
import { UNLOADED } from '../../../src/navigation/world/world.ts';

export const run: MineAiScenario = async ({ bot, signal, log }) => {
  await recordSourceIdentity();
  const damage: unknown[] = [];
  bot._client.on('damage_event', packet => { damage.push(packet); log('REFUSAL_DAMAGE ' + JSON.stringify({packet, position:bot.entity.position, health:bot.health, dimension:bot.game.dimension})); });
  const messages = new Set<string>();
  bot.on('messagestr', message => { messages.add(message); log('REFUSAL_CHAT ' + message); });
  const acknowledge = async (command:string, marker:string) => {
    for (let ticks=0;ticks<100;ticks+=2) {
      signal.throwIfAborted(); bot.chat(command); await bot.waitForTicks(2);
      if ([...messages].some(message=>message.includes(marker))) return;
    }
    throw new Error('The server did not confirm '+marker);
  };
  const checkpoint=(phase:string)=>log('REFUSAL_PHASE '+JSON.stringify({phase,position:bot.entity.position,health:bot.health,dimension:bot.game.dimension,floor:bot.blockAt(new Vec3(0,120,0))?.name,feet:bot.blockAt(new Vec3(0,121,0))?.name,head:bot.blockAt(new Vec3(0,122,0))?.name}));
  checkpoint('start');
  bot.chat('/gamerule sendCommandFeedback true');
  const cases = [
    { x: 3, floor: 'stone_slab[type=bottom]', feet: 'air' },
    { x: 6, floor: 'oak_fence', feet: 'air' },
    { x: 9, floor: 'magma_block', feet: 'air' },
    { x: 12, floor: 'stone', feet: 'lava' },
    { x: 15, floor: 'stone', feet: 'water' },
    { x: 18, floor: 'stone_slab[type=bottom,waterlogged=true]', feet: 'air' },
  ];
  for (const entry of cases) {
    bot.chat(`/setblock ${entry.x} -60 0 ${entry.floor}`);
    bot.chat(`/setblock ${entry.x} -59 0 ${entry.feet}`);
  }
  bot.chat('/setblock 22 -56 0 stone_slab[type=bottom]');
  await bot.waitForTicks(10);
  const world = { blockAt: (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block ? observeMineflayerBlock(block) : UNLOADED;
  }};
  const evidence: unknown[] = [];
  let passed = true;
  const start = bot.entity.position.clone();
  for (const entry of cases) {
    const cell = { x: entry.x, y: -59, z: 0 };
    const admitted = waterableLanding(world, cell);
    const result = await saveWaterLanding(bot, { target: cell, signal, permitted: () => true });
    passed &&= !admitted && result.phase === 'failed';
    evidence.push({ ...entry, observedFloor: bot.blockAt(new Vec3(entry.x, -60, 0))?.name, observedFeet: bot.blockAt(new Vec3(entry.x, -59, 0))?.name, admitted, result });
  }
  const edge = predictWaterLanding({ x: 21.75, y: -54, z: .5 }, { x: 0, y: -1, z: 0 }, world);
  passed &&= edge === null && bot.entity.position.distanceTo(start) < .05;
  checkpoint('before-nether-fill');
  bot.chat('/execute in minecraft:the_nether run forceload add -16 -16 16 16');
  await acknowledge('/execute in minecraft:the_nether if loaded -2 120 -2 if loaded 2 120 2 run tellraw @s \"WATER_NETHER_LOADED\"', 'WATER_NETHER_LOADED');
  bot.chat('/execute in minecraft:the_nether run fill -2 120 -2 2 120 2 stone');
  bot.chat('/execute in minecraft:the_nether run fill -2 121 -2 2 124 2 air');
  await acknowledge('/execute in minecraft:the_nether if block 0 120 0 stone if block 0 121 0 air if block 0 122 0 air run tellraw @s \"WATER_NETHER_PLATFORM_READY\"', 'WATER_NETHER_PLATFORM_READY');
  bot.chat('/execute in minecraft:the_nether run tp @s 0.5 121 0.5');
  for (let ticks = 0; ticks < 100 && bot.game.dimension !== 'the_nether'; ticks++) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  await bot.waitForTicks(5);
  checkpoint('after-nether-teleport');
  const nether = await saveWaterLanding(bot, { signal, permitted: () => true });
  passed &&= bot.blockAt(new Vec3(0,120,0))?.name === 'stone' && bot.blockAt(new Vec3(0,121,0))?.name === 'air' && bot.blockAt(new Vec3(0,122,0))?.name === 'air';
  passed &&= bot.game.dimension === 'the_nether' && !bucketAvailable(bot) && nether.phase === 'failed';
  const detail = { cases: evidence, damage, position:bot.entity.position, edge, dimension: bot.game.dimension, nether, health: bot.health, full: bot.inventory.items().filter(item => item.name === 'water_bucket').length };
  log('BUCKET_REFUSAL_RESULT ' + JSON.stringify(detail));
  return { status: passed && bot.health === 20 && detail.full === 1 ? 'succeeded' : 'failed', detail: JSON.stringify(detail) };
};
