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
 * its inventory, its dimension and position, and its starting health.
 */
export function observeScenarioPlayerPreparation(
  bot: Bot,
  scenario: ScenarioDefinition,
  signal?: AbortSignal,
): PlayerPreparationObservation {
  const player = scenario.players.find(({ name }) => name === bot.username);
  if (!player) throw new Error(`scenario does not declare player '${bot.username}'`);

  const expectedInventory = expectedInventoryCounts(bot, player.inventory);
  const expectedPosition = Array.isArray(player.pos) ? player.pos : undefined;
  const expectedDimension = scenario.world.dimension;
  const expectedHealth = player.health;
  let inventoryUpdateObserved = expectedInventory.size === 0;
  let positionUpdateObserved = expectedPosition === undefined;
  let healthUpdateObserved = expectedHealth === undefined;
  let settle: (() => void) | undefined;

  const preparationMatches = () =>
    inventoryUpdateObserved &&
    positionUpdateObserved &&
    healthUpdateObserved &&
    inventoryMatches(bot, expectedInventory) &&
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
    const itemName = stack.item.startsWith("minecraft:") ? stack.item.slice("minecraft:".length) : stack.item;
    const item = bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`scenario inventory item '${stack.item}' is unknown to client ${bot.version}`);
    counts.set(item.id, (counts.get(item.id) ?? 0) + stack.count);
  }
  return counts;
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
