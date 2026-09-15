/**
 * How many of a named item the bot carries, and how to wait for that count to
 * catch up with what an action just did.
 *
 * Mineflayer resolves a physical act on the first witness the server sends:
 * `consume` on the eating-finished entity status, `placeBlock` on the block
 * update at the target cell. The container broadcast that removes the item
 * from the inventory follows on a later tick. An action that counts on the
 * next line therefore reports the count from before it acted, every time, and
 * a receipt reading `1 → 1` is read as "nothing was consumed" rather than as
 * "the server had not answered yet".
 */
import type { Bot } from "mineflayer";
import { waitForSignal } from "../utils/signals.js";

/**
 * How long a receipt waits for the count it expects.
 *
 * The slot update is a tick or so behind the witness, so five ticks is enough
 * for it and for a slow tick behind it. It is deliberately short: a receipt
 * that cannot say what the inventory holds should say so quickly rather than
 * hold the model for a second on a number it will report as unknown anyway.
 */
export const INVENTORY_SETTLE_MS = 250;

export interface SettledInventoryCount {
  /** The carried count observed when the wait ended. */
  readonly count: number;
  /** Whether that count is the one the action expected, seen before the deadline. */
  readonly confirmed: boolean;
}

/** How many of `itemName` the bot carries across every stack. */
export function carriedCount(bot: Bot, itemName: string): number {
  return bot.inventory.items().reduce((total, item) => total + (item.name === itemName ? item.count : 0), 0);
}

/**
 * The count as it stands, for a path that did not act.
 *
 * An action reaches its receipt down many paths, and only the ones that
 * changed the inventory have anything to wait for. On the rest nothing is in
 * flight, so the current count is already the answer and saying it is
 * confirmed is the truth rather than an assumption.
 */
export function settledNow(bot: Bot, itemName: string): SettledInventoryCount {
  return { count: carriedCount(bot, itemName), confirmed: true };
}

/**
 * Wait until the carried count of `itemName` is `expected`, or the deadline
 * passes; report the count observed either way.
 *
 * Returns at once when the count is already right, so an action that the
 * server answered promptly pays nothing for the wait.
 */
export async function settleInventoryCount(
  bot: Bot,
  itemName: string,
  expected: number,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<SettledInventoryCount> {
  return settleCount(bot, itemName, (count) => count === expected, options);
}

/** Recipe batches may produce more than requested; confirm the requested minimum. */
export function settleInventoryMinimum(
  bot: Bot,
  itemName: string,
  minimum: number,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<SettledInventoryCount> {
  return settleCount(bot, itemName, (count) => count >= minimum, options);
}

async function settleCount(
  bot: Bot,
  itemName: string,
  accepts: (count: number) => boolean,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<SettledInventoryCount> {
  const reached = await waitForSignal(() => accepts(carriedCount(bot, itemName)), bot.inventory, "updateSlot", {
    timeoutMs: options.timeoutMs ?? INVENTORY_SETTLE_MS,
    context: { signal: options.signal },
  });
  return { count: carriedCount(bot, itemName), confirmed: reached === true };
}
