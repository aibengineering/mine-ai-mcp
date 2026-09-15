import type {Bot, BotEvents} from 'mineflayer';
import type {Entity} from 'prismarine-entity';
import {Vec3} from 'vec3';

import {type LastDeath, readLastDeath, type SqlBotData} from '../../bot-data/index.js';
import {createMovements, type NavigationRuntime, nearGoal} from '../../navigation/index.js';
import {prepareBotForMovement} from '../../session/prepare-body.js';
import type {ObserveRequest} from '../../session/request.js';
import type {DiscardedItems} from '../../world/discarded-items.js';
import {droppedItemName, pickupObservedItem} from '../../world/item-pickup.js';
import {type ActionContext, defineAction} from '../action.js';
import {pickupCheckpointSchema} from '../checkpoint-schemas.js';
import {inventoryCounts} from '../collect-block/collection-facts.js';

import {parsePickUpItemsRequest, PICK_UP_ITEMS, PICK_UP_ITEMS_DESCRIPTION, pickUpItemsInputSchema, type PickUpItemsRequest, type PickUpItemsResult, pickUpItemsResultSchema} from './contract.js';

const STALE_RECOVERY_MS = 5 * 60_000;
type Point = {
  x: number; y: number; z: number
};
type Outcome = 'collected'|'gone_unconfirmed'|'unreachable'|'inventory_full';
interface Target {
  id: number;
  item: string;
  observedCount: number;
  position: Point;
  outcome: Outcome|null;
  collectedEvent: boolean
}
interface State {
  center: Point|null;
  radius: number;
  recovery: LastDeath|null;
  targets: Target[];
  next: number;
  currentTargetId: number|null;
  currentTargetDistance: number|null;
  frozen: boolean
}

function gains(bot: Bot, before: Readonly<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, count] of Object.entries(inventoryCounts(bot))) {
    const gain = Math.max(0, count - (before[name] ?? 0));
    if (gain > 0) result[name] = gain;
  }
  return result;
}
function itemCount(entity: Entity): number {
  try {
    return entity.getDroppedItem()?.count ?? 1;
  } catch {
    return 1;
  }
}
function scan(
    bot: Bot, discarded: DiscardedItems, request: PickUpItemsRequest, center: Point, radius: number): Target[] {
  const origin = new Vec3(center.x, center.y, center.z);
  return Object.values(bot.entities)
      .map(entity => ({entity, item: droppedItemName(entity)}))
      .filter(
          (candidate):
              candidate is {
                entity: Entity;
                item: string
              } => candidate.item !== null && !discarded.ignored().has(candidate.entity.id) &&
              (!request.item || candidate.item === request.item) &&
              candidate.entity.position.distanceTo(origin) <= radius)
      .sort(
          (a, b) =>
              a.entity.position.distanceTo(bot.entity.position) - b.entity.position.distanceTo(bot.entity.position))
      .map(({entity, item}) => ({
             id: entity.id,
             item,
             observedCount: itemCount(entity),
             position: {x: entity.position.x, y: entity.position.y, z: entity.position.z},
             outcome: null,
             collectedEvent: false
           }));
}
function initialise(bot: Bot, data: SqlBotData, request: PickUpItemsRequest, state: State): string|null {
  if (state.center) return null;
  const death = request.recoverDeathItems ? readLastDeath(data, bot.username) : null;
  state.recovery = death;
  state.center = death?.position ?? request.center ??
      {x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z};
  state.radius = death ? 16 : request.radius;
  if (request.recoverDeathItems && !death) return '[NO_RECORDED_DEATH] No retained death is available.';
  if (death && death.dimension !== bot.game.dimension)
    return `[DEATH_DIMENSION_MISMATCH] Last death was in ${death.dimension}; bot is in ${bot.game.dimension}.`;
  if (death && Date.now() - Date.parse(death.observedAt) > STALE_RECOVERY_MS)
    return '[DEATH_RECORD_STALE] More than five minutes of wall time passed. This refuses conservatively; unloaded chunks pause item despawn age.';
  return null;
}

function addObservedTargets(state: State, observed: readonly Target[]): void {
  if (state.frozen) return;
  for (const target of observed) {
    if (!state.targets.some(existing => existing.id === target.id)) state.targets.push(target);
  }
}

function reconcileCollected(bot: Bot, before: Record<string, number>, state: State): void {
  const available = gains(bot, before);
  const credited: Record<string, number> = {};
  for (const target of state.targets) {
    if (!target.collectedEvent) continue;
    const used = credited[target.item] ?? 0;
    if (used + target.observedCount <= (available[target.item] ?? 0)) {
      target.outcome = 'collected';
      credited[target.item] = used + target.observedCount;
    }
  }
}
async function approach(
    bot: Bot, navigation: NavigationRuntime, state: State, signal?: AbortSignal): Promise<string|null> {
  const center = state.center!;
  const range = Math.min(8, state.radius);
  if (bot.entity.position.distanceTo(new Vec3(center.x, center.y, center.z)) <= range) return null;
  const route = await navigation.navigate({movements: createMovements(bot), goal: nearGoal(center, range), signal});
  return route.status === 'completed' ? null : `[RECOVERY_SITE_UNREACHABLE] ${route.reason}`;
}
async function pursue(
    bot: Bot, navigation: NavigationRuntime, target: Target, state: State, signal?: AbortSignal): Promise<Outcome> {
  const before = inventoryCounts(bot)[target.item] ?? 0;
  let targetCollected = false;
  const collected: BotEvents['playerCollect'] = (collector, item) => {
    if (collector.id === bot.entity.id && item.id === target.id) targetCollected = true;
  };
  const distance = () => {
    const current = bot.entities[target.id];
    state.currentTargetDistance = current ? current.position.distanceTo(bot.entity.position) : null;
  };
  bot.on('playerCollect', collected);
  bot.on('physicsTick', distance);
  try {
    const result = await pickupObservedItem(bot, {
      entityId: target.id,
      navigate: navigation.navigate,
      movements: createMovements(bot),
      signal,
      hasArrived: () => targetCollected && (inventoryCounts(bot)[target.item] ?? 0) > before
    });
    if (result.kind === 'collected') return 'collected';
    if (result.kind === 'inventory_full') return 'inventory_full';
    return result.kind === 'item_gone' ? 'gone_unconfirmed' : 'unreachable';
  } finally {
    bot.off('physicsTick', distance);
    bot.off('playerCollect', collected);
  }
}
function evidence(bot: Bot, request: PickUpItemsRequest, before: Record<string, number>, state: State) {
  return {
    item: request.item ?? null,
    center: state.center!,
    radius: state.radius,
    observed: state.targets.length,
    collected: state.targets.filter(target => target.outcome === 'collected').length,
    gainedByItem: gains(bot, before),
    emptySlots: bot.inventory.emptySlotCount(),
    sightings: state.targets.map(({collectedEvent: _collectedEvent, ...target}) =>
      ({...target, outcome: target.outcome ?? 'unreachable' as const})),
    recovery: state.recovery ? {
      dimension: state.recovery.dimension,
      position: state.recovery.position,
      observedAt: state.recovery.observedAt,
      cause: state.recovery.cause,
      wallAgeMs: Math.max(0, Date.now() - Date.parse(state.recovery.observedAt))
    } :
                               null
  };
}
function begin(
    bot: Bot, navigation: NavigationRuntime, data: SqlBotData, discarded: DiscardedItems, request: PickUpItemsRequest,
    lifetime: AbortSignal, observe: ObserveRequest = () => {}) {
  const before = inventoryCounts(bot);
  const state: State = {
    center: null,
    radius: request.radius,
    recovery: null,
    targets: [],
    next: 0,
    currentTargetId: null,
    currentTargetDistance: null,
    frozen: false
  };
  const refusal = initialise(bot, data, request, state);
  const observeLoaded = () => addObservedTargets(state, scan(bot, discarded, request, state.center!, state.radius));
  const collected: BotEvents['playerCollect'] = (collector, item) => {
    if (collector.id !== bot.entity.id) return;
    const target = state.targets.find(candidate => candidate.id === item.id);
    if (target) target.collectedEvent = true;
  };
  if (!refusal) {
    observeLoaded();
    bot.on('entitySpawn', observeLoaded);
    bot.on('entityUpdate', observeLoaded);
    bot.on('itemDrop', observeLoaded);
    bot.on('playerCollect', collected);
    lifetime.addEventListener('abort', () => {
      bot.off('entitySpawn', observeLoaded);
      bot.off('entityUpdate', observeLoaded);
      bot.off('itemDrop', observeLoaded);
      bot.off('playerCollect', collected);
    }, {once: true});
  }
  observe(() => ({
            baseline: {...before},
            checkpoint: {
              observed: state.targets.length,
              collected: state.targets.filter(t => t.outcome === 'collected').length,
              currentTargetId: state.currentTargetId,
              currentTargetDistance: state.currentTargetDistance
            },
            completion: {
              kind: 'current',
              observed: state.frozen && state.next >= state.targets.length,
              owes: 'Every item in the stable loaded-area snapshot has an honest terminal outcome.'
            }
          }));
  return async (context: ActionContext): Promise<PickUpItemsResult> => {
    if (refusal) return {status: 'failed', error: refusal, pickup: evidence(bot, request, before, state)};
    const routeFailure = await approach(bot, navigation, state, context.signal);
    if (routeFailure) return {status: 'failed', error: routeFailure, pickup: evidence(bot, request, before, state)};
    observeLoaded();
    state.frozen = true;
    reconcileCollected(bot, before, state);
    while (state.next < state.targets.length) {
      context.signal?.throwIfAborted();
      const target = state.targets[state.next]!;
      if (target.outcome === 'collected') { state.next++; continue; }
      state.currentTargetId = target.id;
      state.currentTargetDistance = bot.entities[target.id]?.position.distanceTo(bot.entity.position) ?? null;
      target.outcome =
          bot.entities[target.id] ? await pursue(bot, navigation, target, state, context.signal) : 'gone_unconfirmed';
      reconcileCollected(bot, before, state);
      state.next++;
      if (target.outcome === 'inventory_full') {
        for (const rest of state.targets.slice(state.next)) rest.outcome = 'inventory_full';
        state.next = state.targets.length;
      }
    }
    state.currentTargetId = null;
    state.currentTargetDistance = null;
    reconcileCollected(bot, before, state);
    const pickup = evidence(bot, request, before, state);
    const net = Object.values(pickup.gainedByItem).reduce((sum, count) => sum + count, 0);
    const complete = pickup.observed > 0 && pickup.sightings.every(s => s.outcome === 'collected');
    if (complete && net > 0) return {status: 'succeeded', pickup};
    const error = pickup.observed === 0 ?
        '[NO_MATCHING_ITEMS] No matching loaded dropped items were observed in the area.' :
        net === 0 ? '[NO_CONFIRMED_PICKUP] No inventory gain confirmed a pickup.' :
                    '[PICKUP_INCOMPLETE] Some observed items were not confirmed in inventory.';
    return net > 0 ? {status: 'partial', error, pickup} : {status: 'failed', error, pickup};
  };
}
export function formatPickUpItemsResult(result: PickUpItemsResult): string {
  const p = result.pickup;
  return [
    `- Matching entities observed: ${p.observed}`, `- Confirmed pickups: ${p.collected}`,
    `- Inventory gains: ${Object.entries(p.gainedByItem).map(([n, c]) => `${n} +${c}`).join(', ') || 'none'}`,
    `- Empty inventory slots: ${p.emptySlots}`,
    ...(result.status === 'succeeded' ? [] : [`\n**Observed stop:** ${result.error}`])
  ].join('\n');
}
export function createPickUpItemsAction(
    bot: Bot, navigation: NavigationRuntime, data: SqlBotData, discarded: DiscardedItems) {
  return defineAction({
    checkpointSchema: pickupCheckpointSchema,
    name: PICK_UP_ITEMS,
    description: PICK_UP_ITEMS_DESCRIPTION,
    inputSchema: pickUpItemsInputSchema,
    resultSchema: pickUpItemsResultSchema,
    formatResult: formatPickUpItemsResult,
    execution: {kind: 'resumable_task', prepare: () => prepareBotForMovement(bot, navigation)},
    annotations: {title: PICK_UP_ITEMS, destructiveHint: false, openWorldHint: true},
    parse: parsePickUpItemsRequest,
    begin: (request, lifetime, observe) => begin(bot, navigation, data, discarded, request, lifetime, observe)
  });
}
