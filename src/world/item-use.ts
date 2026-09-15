/**
 * Use the held item at a looked-at point, and wait for what it should change.
 *
 * A right-click reaches the server in one of two packets. "Use item" names
 * no block: the server casts its own ray from the player's eyes through
 * where they are looking, which is how a bucket finds its source or its
 * face. "Use item on block" names a block and a face, and is the only way
 * an item that acts on a block, flint and steel among them, acts at all. So
 * a use either looks at a point, or names a block and a face; either way the
 * client then confirms the world and the hand changed the way the item
 * should have changed them. Placement in `placement.ts` is the on-block
 * form specialised for putting a block down.
 */
import type { Bot } from "mineflayer";
import { asVec3, type Position3 } from "../utils/index.js";
import type { InventoryItem, WorldBlock } from "./placement.js";
import { carriedCount } from "./inventory-count.js";

/** A cell that should read as `matches` once the use has taken effect. */
export interface ExpectedCell {
  readonly position: Position3;
  readonly matches: (block: WorldBlock) => boolean;
}

export interface ItemUse {
  readonly item: InventoryItem;
  /** The point the player looks at; the server's ray passes through it. */
  readonly lookAt: Position3;
  /** Use the item on this block's face instead of into the air, for items that act on a block. */
  readonly on?: { readonly block: WorldBlock; readonly face: Position3 };
  readonly expectedCells?: readonly ExpectedCell[];
  /** The item name the hand should hold afterwards, or null for an empty hand; omitted means the hand is not checked. */
  readonly expectedHeldItem?: string | null;
  /** An observed inventory gain, including results placed outside the held stack. */
  readonly expectedInventoryGain?: { readonly item: string; readonly count: number };
  /** How many ticks to wait for the change before reporting failure. */
  readonly timeoutTicks?: number;
  readonly signal?: AbortSignal;
}

export type ItemUseResult = { kind: "used" } | { kind: "failed"; error: string };

const DEFAULT_TIMEOUT_TICKS = 40;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function cellsSettled(bot: Bot, use: ItemUse): boolean {
  return (use.expectedCells ?? []).every((cell) => {
    const block = bot.blockAt(asVec3(cell.position));
    return block !== null && cell.matches(block);
  });
}

function handSettled(bot: Bot, use: ItemUse): boolean {
  if (use.expectedHeldItem === undefined) return true;
  return (bot.heldItem?.name ?? null) === use.expectedHeldItem;
}

function observed(bot: Bot, use: ItemUse): string {
  const cells = (use.expectedCells ?? []).map((cell) => {
    const block = bot.blockAt(asVec3(cell.position));
    return `(${cell.position.x}, ${cell.position.y}, ${cell.position.z})=${block?.name ?? "unloaded"}`;
  });
  const hand = use.expectedHeldItem === undefined ? [] : [`hand=${bot.heldItem?.name ?? "empty"}`];
  return [...cells, ...hand].join(", ");
}

/** Equip, look, use, and confirm the expected cells and hand; the item is released whatever happens. */
export async function useItemAt(bot: Bot, use: ItemUse): Promise<ItemUseResult> {
  const timeoutTicks = use.timeoutTicks ?? DEFAULT_TIMEOUT_TICKS;
  const gain = use.expectedInventoryGain;
  const inventoryBefore = gain ? carriedCount(bot, gain.item) : 0;
  try {
    use.signal?.throwIfAborted();
    await bot.equip(use.item, "hand");
    use.signal?.throwIfAborted();
    await bot.lookAt(asVec3(use.lookAt), true);
    use.signal?.throwIfAborted();
    if (use.on) await bot.activateBlock(use.on.block, asVec3(use.on.face));
    else bot.activateItem();
    for (let tick = 0; tick < timeoutTicks; tick += 1) {
      await bot.waitForTicks(1);
      use.signal?.throwIfAborted();
      const inventorySettled = !gain || carriedCount(bot, gain.item) >= inventoryBefore + gain.count;
      if (cellsSettled(bot, use) && handSettled(bot, use) && inventorySettled) return { kind: "used" };
    }
    return {
      kind: "failed",
      error: `The use of ${use.item.name} was not confirmed within ${timeoutTicks} ticks; observed ${[
        observed(bot, use),
        ...(gain
          ? [
              `${gain.item} inventory=${carriedCount(bot, gain.item)}, expected at least ${inventoryBefore + gain.count}`,
            ]
          : []),
      ]
        .filter(Boolean)
        .join(", ")}.`,
    };
  } catch (cause) {
    if (use.signal?.aborted) throw cause;
    return { kind: "failed", error: message(cause) };
  } finally {
    // A bucket's use is instantaneous, but Mineflayer keeps the hand flagged
    // as in use until told otherwise, and a later action would inherit it.
    if (bot.usingHeldItem) bot.deactivateItem();
  }
}
