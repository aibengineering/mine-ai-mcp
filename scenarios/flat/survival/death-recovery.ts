import {pickUpItemsResultSchema} from '@aibengineering/mine-ai-mcp';

import {openRuntime} from '../../src/runtime.ts';
import type {MineAiScenario} from '../../src/scenario-client.ts';

export const run: MineAiScenario = async (context) => {
  const {bot, signal} = context;
  await bot.waitForChunksToLoad();
  await using runtime = await openRuntime(context, 'death-recovery');
  const action = runtime.actions.find((candidate) => candidate.name === 'pick_up_items')!;
  const before = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
  const died = new Promise<void>((resolve) => bot.once('death', resolve));
  const spawned = new Promise<void>((resolve) => bot.once('spawn', resolve));
  bot.chat('/kill @s');
  await died;
  await spawned;
  await bot.waitForTicks(10);
  const output = await runtime.run(action, {recover_death_items: true}, signal);
  const after = bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
  const recovered = after / before;
  const result = 'kind' in output.result ? null : pickUpItemsResultSchema.parse(output.result);
  const gained = result ? Object.values(result.pickup.gainedByItem).reduce((sum, count) => sum + count, 0) : 0;
  const passed = result?.status === 'succeeded' && recovered >= 0.9 && gained === after;
  return {status: passed ? 'succeeded' : 'failed', detail: JSON.stringify({before, after, recovered, gained, output})};
};
