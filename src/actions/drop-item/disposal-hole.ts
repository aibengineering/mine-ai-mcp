import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BreakBlockInPlace } from "../../navigation/execution/in-place-break.js";
import type { MovementPolicy } from "../../navigation/movements/policy.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import type { BlockPosition } from "../../navigation/world/world.js";
import { waitForSignal } from "../../utils/signals.js";
import type { ActionContext } from "../action.js";
import type { DroppedItem, HoleClosure } from "./contract.js";
import { type InventoryItem, type placeSolidBlockInto } from "../../world/placement.js";
import { PLAYER_HALF_WIDTH } from "../../world/player-physics.js";

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export class DisposalHoleError extends Error {}

/** Full dry walls retain the discards and exclude liquid or a cave opening. */
function wall(bot: Bot, position: Vec3): boolean {
  const block = bot.blockAt(position);
  if (!block) return false;
  const { traits, geometry } = observeMineflayerBlock(block);
  return geometry.fullCube && geometry.safeSupport && !traits.waterlogged && !traits.falling;
}

function air(bot: Bot, position: Vec3): boolean {
  const block = bot.blockAt(position);
  return block !== null && ["air", "cave_air", "void_air"].includes(block.name);
}

function enclosed(bot: Bot, bottom: Vec3): boolean {
  return (
    wall(bot, bottom.offset(0, -1, 0)) &&
    SIDES.every(([dx, dz]) => wall(bot, bottom.offset(dx, 0, dz)) && wall(bot, bottom.offset(dx, 1, dz)))
  );
}

/** Opening a wall must not admit a fluid or a falling block from outside the pit. */
function dryOpening(bot: Bot, bottom: Vec3): boolean {
  return [2, 3].every((height) =>
    [...SIDES.map(([x, z]) => bottom.offset(x, height, z)), bottom.offset(0, height + 1, 0)].every((position) => {
      const block = bot.blockAt(position);
      if (!block) return false;
      const { traits } = observeMineflayerBlock(block);
      return traits.liquid === null && !traits.waterlogged && !traits.falling;
    }),
  );
}

/** Make an enclosed pit beside the body, clearing a tunnel wall above it when needed. */
export async function prepareDisposalHole(
  bot: Bot,
  movements: MovementPolicy,
  breakInPlace: BreakBlockInPlace,
  context: ActionContext,
): Promise<Vec3> {
  const feet = bot.entity.position.floored();
  if (!bot.entity.onGround || !wall(bot, feet.offset(0, -1, 0)))
    throw new DisposalHoleError("[DROP_HOLE_UNAVAILABLE] The bot is not standing on full, dry ground.");
  const position = bot.entity.position;
  const candidates = SIDES.map(([dx, dz]) => feet.offset(dx, -2, dz))
    // Never remove any ground beneath the body's footprint at a cell edge.
    .filter(
      (cell) =>
        Math.abs(position.x - cell.x - 0.5) >= 0.5 + PLAYER_HALF_WIDTH ||
        Math.abs(position.z - cell.z - 0.5) >= 0.5 + PLAYER_HALF_WIDTH,
    )
    .sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(position) - b.offset(0.5, 0, 0.5).distanceTo(position));
  const opening = (cell: Vec3) => [cell.offset(0, 3, 0), cell.offset(0, 2, 0), cell.offset(0, 1, 0), cell];
  const bottom = candidates.find((cell) => {
    if (!enclosed(bot, cell) || !dryOpening(bot, cell)) return false;
    return opening(cell).every((position) => {
      if (air(bot, position)) return true;
      const block = bot.blockAt(position);
      if (!block || !wall(bot, position)) return false;
      const { traits } = observeMineflayerBlock(block);
      return traits.safeToBreak && !traits.interactive;
    });
  });
  if (!bottom)
    throw new DisposalHoleError("[DROP_HOLE_UNAVAILABLE] No adjacent terrain can be excavated into a dry, enclosed disposal pit.");
  for (const position of opening(bottom)) {
    context.signal?.throwIfAborted();
    if (air(bot, position)) continue;
    if (!enclosed(bot, bottom) || !dryOpening(bot, bottom))
      throw new DisposalHoleError("[DROP_HOLE_CHANGED] The hole's enclosing blocks changed before digging.");
    const result = await breakInPlace({ movements, position, signal: context.signal });
    if (result.status !== "broken") throw new DisposalHoleError(`[DROP_HOLE_DIG_FAILED] ${result.reason}`);
  }
  if (!enclosed(bot, bottom) || !air(bot, bottom) || !air(bot, bottom.offset(0, 1, 0)))
    throw new DisposalHoleError(
      "[DROP_HOLE_NOT_OBSERVED] A dry, enclosed two-block-deep hole was not observed after digging.",
    );
  // Aim through the opening. Aiming at the bottom throws too steeply: the
  // stack's collision box clips the near rim before it crosses the edge.
  // Aim half a block above the lip to clear the item's own collision radius.
  // Await the normal look so the server receives that orientation before toss.
  await bot.lookAt(bottom.offset(0.5, 2.5, 0.5));
  return bottom;
}

/** Existing entities may merge with a toss; retain their counts as well as their ids. */
export function snapshotDroppedCounts(bot: Bot): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const entity of Object.values(bot.entities)) {
    try {
      const item = entity.getDroppedItem();
      if (item) counts.set(entity.id, item.count);
    } catch {
      // Metadata has not arrived yet; it cannot establish an item count.
    }
  }
  return counts;
}

/** Inventory loss alone does not show that the toss landed below pickup height. */
export async function observeHoleDrops(
  bot: Bot,
  bottom: BlockPosition,
  baseline: ReadonlyMap<number, number>,
  dropped: readonly DroppedItem[],
  context: ActionContext,
  settleMs = 1_500,
): Promise<boolean> {
  const expected = new Map<string, number>();
  for (const entry of dropped)
    if (entry.dropped > 0) expected.set(entry.item, (expected.get(entry.item) ?? 0) + entry.dropped);
  return (
    (await waitForSignal(
      () => {
        const observed = new Map<string, number>();
        for (const entity of Object.values(bot.entities)) {
          const p = entity.position;
          if (Math.floor(p.x) !== bottom.x || Math.floor(p.z) !== bottom.z || p.y < bottom.y || p.y > bottom.y + 0.3)
            continue;
          try {
            const item = entity.getDroppedItem();
            if (item)
              observed.set(
                item.name,
                (observed.get(item.name) ?? 0) + Math.max(0, item.count - (baseline.get(entity.id) ?? 0)),
              );
          } catch {
            // Wait for the dropped stack's metadata before counting it.
          }
        }
        return [...expected].every(([name, count]) => (observed.get(name) ?? 0) >= count);
      },
      bot,
      ["physicsTick", "entityMoved", "entityUpdate", "itemDrop"],
      {
        // Falling from hand height to this two-deep floor takes under a second.
        // The default allows 1.5 seconds for fall and server observation, then reports failure.
        timeoutMs: settleMs,
        context,
      },
    )) === true
  );
}

/** What `sealDisposalHole` reports; the caller adds how far it then stepped back. */
export type DisposalHoleSeal = Pick<HoleClosure, "item" | "placed"> & { readonly error?: string };

/** Use the first carried, physically safe block admitted by the live scaffold policy. */
function plugMaterial(bot: Bot): InventoryItem | null {
  return preferredScaffoldItem(bot);
}

/**
 * Plug the shaft above the discards so nothing later paths down into the pit.
 *
 * A collect request issued straight after a hole drop walked back into the
 * open pit it had just tossed into. The cell above the items is filled first,
 * which is what keeps them out of reach; the ground-level cell follows when
 * material allows, so the surface is flush again and no pathfinder sees a
 * one-deep step to drop into.
 */
export async function sealDisposalHole(
  bot: Bot,
  bottom: Vec3,
  place: typeof placeSolidBlockInto,
  context: ActionContext,
): Promise<DisposalHoleSeal> {
  let item: string | null = null;
  let placed = 0;
  for (const cell of [bottom.offset(0, 1, 0), bottom.offset(0, 2, 0)]) {
    context.signal?.throwIfAborted();
    if (!air(bot, cell)) continue;
    const material = plugMaterial(bot);
    if (!material)
      return {
        item,
        placed,
        error: `[DROP_HOLE_OPEN] No full, dry, non-falling block is carried to plug the hole at (${cell.x}, ${cell.y}, ${cell.z}).`,
      };
    const result = await place(bot, cell, material, { signal: context.signal });
    if (result.kind === "failed")
      return { item, placed, error: `[DROP_HOLE_OPEN] Could not plug (${cell.x}, ${cell.y}, ${cell.z}): ${result.error}` };
    item = material.name;
    placed += 1;
  }
  return { item, placed };
}
