import type { Bot } from "mineflayer";
import type { ScenarioDefinition } from "mine-labs/client";

const POSITION_TOLERANCE = 1.5;
/** Regeneration can add half a heart between the arranged wound and this observation. */
const HEALTH_TOLERANCE = 1;

export interface PlayerPreparationObservation {
  wait(): Promise<void>;
  close(): void;
}

/**
 * Arm before reporting ready, then prove that declared player setup reached
 * this Mineflayer client after Mine Labs provisioned the server-side player:
 * its inventory and equipment, its dimension and position, and its starting health.
 */
export function observeScenarioPlayerPreparation(
  bot: Bot,
  scenario: ScenarioDefinition,
  signal?: AbortSignal,
): PlayerPreparationObservation {
  const player = scenario.players.find(({ name }) => name === bot.username);
  if (!player) throw new Error(`scenario does not declare player '${bot.username}'`);

  // The main hand occupies a normal hotbar slot; armour and offhand do not.
  const expectedInventory = expectedInventoryCounts(bot, [
    ...player.inventory,
    ...(player.equipment?.mainhand ? [{ item: player.equipment.mainhand, count: 1 }] : []),
  ]);
  const equipmentSlots = { head: 5, chest: 6, legs: 7, feet: 8, mainhand: 36 + bot.quickBarSlot, offhand: 45 };
  const expectedEquipment = Object.entries(player.equipment ?? {}).map(([name, item]) => {
    const slot = equipmentSlots[name as keyof typeof equipmentSlots];
    const type = scenarioItemType(bot, item);
    return { slot, type };
  });
  const expectedPosition = Array.isArray(player.pos) ? player.pos : undefined;
  const expectedDimension = scenario.world.dimension;
  const expectedHealth = player.health;
  let inventoryUpdateObserved = expectedInventory.size === 0 && expectedEquipment.length === 0;
  let positionUpdateObserved = expectedPosition === undefined;
  let healthUpdateObserved = expectedHealth === undefined;
  let settle: (() => void) | undefined;

  const preparationMatches = () =>
    inventoryUpdateObserved &&
    positionUpdateObserved &&
    healthUpdateObserved &&
    inventoryMatches(bot, expectedInventory) &&
    expectedEquipment.every(({ slot, type }) => bot.inventory.slots[slot]?.type === type) &&
    bot.game.dimension === expectedDimension &&
    positionMatches(bot, expectedPosition) &&
    healthMatches(bot, expectedHealth);
  const check = () => {
    if (preparationMatches()) settle?.();
  };
  const onInventoryUpdate = () => {
    inventoryUpdateObserved = true;
    check();
  };
  const onMove = () => {
    positionUpdateObserved = true;
    check();
  };
  const onHealth = () => {
    healthUpdateObserved = true;
    check();
  };

  bot.inventory.on("updateSlot", onInventoryUpdate);
  bot.on("move", onMove);
  // A teleport is a server-set position, which arrives as a forced move — and
  // as a fresh spawn when it crosses into another dimension. Neither is a
  // physics step, so neither reaches `move` while the client is standing still.
  bot.on("forcedMove", onMove);
  bot.on("spawn", onMove);
  bot.on("health", onHealth);

  const close = () => {
    bot.inventory.removeListener("updateSlot", onInventoryUpdate);
    bot.removeListener("move", onMove);
    bot.removeListener("forcedMove", onMove);
    bot.removeListener("spawn", onMove);
    bot.removeListener("health", onHealth);
  };

  return {
    async wait(): Promise<void> {
      signal?.throwIfAborted();
      if (preparationMatches()) return;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener("abort", onAbort);
          settle = undefined;
          resolve();
        };
        const onAbort = () => {
          settle = undefined;
          reject(signal?.reason);
        };
        settle = finish;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    close,
  };
}

function expectedInventoryCounts(
  bot: Bot,
  inventory: ScenarioDefinition["players"][number]["inventory"],
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const stack of inventory) {
    const type = scenarioItemType(bot, stack.item);
    counts.set(type, (counts.get(type) ?? 0) + stack.count);
  }
  return counts;
}

function scenarioItemType(bot: Bot, name: string): number {
  const item = bot.registry.itemsByName[name.replace(/^minecraft:/u, "")];
  if (!item) throw new Error(`scenario item '${name}' is unknown to client ${bot.version}`);
  return item.id;
}

function inventoryMatches(bot: Bot, expected: ReadonlyMap<number, number>): boolean {
  const actual = new Map<number, number>();
  for (const item of bot.inventory.items()) {
    actual.set(item.type, (actual.get(item.type) ?? 0) + item.count);
  }
  if (actual.size !== expected.size) return false;
  for (const [itemId, count] of expected) {
    if (actual.get(itemId) !== count) return false;
  }
  return true;
}

function positionMatches(bot: Bot, expected: readonly [number, number, number] | undefined): boolean {
  if (!expected) return true;
  const [x, y, z] = expected;
  const dx = bot.entity.position.x - x;
  const dy = bot.entity.position.y - y;
  const dz = bot.entity.position.z - z;
  return dx * dx + dy * dy + dz * dz <= POSITION_TOLERANCE * POSITION_TOLERANCE;
}

function healthMatches(bot: Bot, expected: number | undefined): boolean {
  return expected === undefined || Math.abs(bot.health - expected) <= HEALTH_TOLERANCE;
}
