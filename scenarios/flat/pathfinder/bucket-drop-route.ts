import { recordSourceIdentity } from "../../src/source-identity.ts";
import { openRuntime, standStill } from '../../src/runtime.ts';
import type { MineAiScenario } from '../../src/scenario-client.ts';
import { bucketDropTotals, predictWaterLanding } from '../../../src/navigation/mineflayer/water-landing.ts';
import { observeMineflayerBlock } from '../../../src/navigation/mineflayer/world.ts';
import { UNLOADED } from '../../../src/navigation/world/world.ts';
import { Vec3 } from 'vec3';
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal, log } = context;
  await standStill(context);
  const runtime = await openRuntime(context, 'bucket-drop-route');
  const params = context.scenario.params as { impulse?: { x: number; y: number; z: number }; impulseAt?: number };
  let airborneTicks = 0, injected = false;
  let minimumHealth = bot.health, deaths = 0;
  const tick = () => {
    if (!bot.entity.onGround) airborneTicks++;
    if (params.impulse && !injected && airborneTicks === (params.impulseAt ?? 4)) {
      injected = true;
      bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: params.impulse });
    }
    minimumHealth = Math.min(minimumHealth, bot.health);
    log('BUCKET_ROUTE_TICK ' + JSON.stringify({ position: bot.entity.position, health: bot.health, held: bot.heldItem?.name,
      prediction: params.impulse ? predictWaterLanding(bot.entity.position, bot.entity.velocity, { blockAt: (x, y, z) => {
        const block = bot.blockAt(new Vec3(x, y, z));
        return block ? observeMineflayerBlock(block) : UNLOADED;
      } }) : undefined,
    }));
  };
  const death = () => { deaths++; minimumHealth = 0; };
  bot.on('physicsTick', tick);
  bot.on('death', death);
  try {
    const action = runtime.actions.find(action => action.name === "navigate")!;
    const outcome = (await runtime.run(action, { x: 1, y: -59, z: 0, range: 0, dig: false, scaffold: false }, signal)).result;
    await bot.waitForTicks(10);
    await runtime.captureIncident();
    const result = { outcome, minimumHealth, deaths, injected, totals: bucketDropTotals(bot), position: bot.entity.position };
    log('BUCKET_ROUTE_RESULT ' + JSON.stringify(result));
    return { status: outcome.status === 'succeeded' && deaths === 0 && minimumHealth === 20 && (!params.impulse || injected) &&
      result.totals.count > 0 && result.totals.waterRecovered === result.totals.count &&
      bot.inventory.items().some(i => i.name === 'water_bucket') ? 'succeeded' : 'failed', detail: JSON.stringify(result) };
  }
  finally {
    bot.off('physicsTick', tick);
    bot.off('death', death);
    await runtime.close();
  }
};
