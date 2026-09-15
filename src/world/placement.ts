import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { setSneaking } from "../navigation/mineflayer/sneak.js";
import { blockClass } from "../navigation/mineflayer/world.js";
import { asVec3, cellIntersectsBody, type Position3 } from "../utils/index.js";
import { isReplaceableForPlacement } from "./block-classification.js";
import { carriedCount, settleInventoryCount } from "./inventory-count.js";
import { recordCombatResourceReceipt } from "../runtime/combat-resource-receipts.js";

export type WorldBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
export type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

interface PlacementOptionsBot extends Bot {
  _placeBlockWithOptions?: (
    support: WorldBlock,
    face: Vec3,
    options: { forceLook: "ignore"; swingArm: "right" },
  ) => Promise<void>;
}

/**
 * Place against a face without Mineflayer re-aiming; the caller owns the look.
 *
 * Mineflayer's own `placeBlock` looks at the face centre first, unforced, so
 * the head turns toward it over several ticks. For a face directly beneath the
 * feet that yaw is arbitrary, which spun the bot on every pillar block.
 */
export function placeWithoutLooking(bot: Bot, support: WorldBlock, face: Vec3): Promise<void> {
  const placementBot = bot as PlacementOptionsBot;
  return placementBot._placeBlockWithOptions
    ? placementBot._placeBlockWithOptions(support, face, { forceLook: "ignore", swingArm: "right" })
    : bot.placeBlock(support, face);
}

export interface BlockPlacement {
  readonly item: InventoryItem;
  readonly support: WorldBlock;
  readonly face: Position3;
  readonly expectedCells: readonly [Position3, ...Position3[]];
  readonly matches: (block: WorldBlock) => boolean;
  /** The horizontal direction the player must face while placing an oriented block. */
  readonly lookDirection?: Position3;
  readonly signal?: AbortSignal;
}

export type BlockPlacementResult = { kind: "placed"; block: WorldBlock } | { kind: "failed"; error: string };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isBlockUpdateTimeout(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.startsWith("Event blockUpdate:") &&
    cause.message.includes(" did not fire within timeout of ")
  );
}

function observedCells(bot: Bot, placement: BlockPlacement): string {
  return placement.expectedCells
    .map((position) => {
      const block = bot.blockAt(asVec3(position));
      return `(${position.x}, ${position.y}, ${position.z})=${block?.name ?? "unloaded"}`;
    })
    .join(", ");
}

/** Only an unambiguous full cube permits a cell-sized clearance test before placement. */
function fullCubeCell(bot: Bot, placement: BlockPlacement): Position3 | null {
  if (placement.expectedCells.length !== 1) return null;
  const candidate = bot.registry?.blocksByName[placement.item.name];
  if (!candidate || candidate.minStateId !== candidate.maxStateId) return null;
  const shapes = blockClass(bot).fromStateId(candidate.defaultState, 0).shapes;
  const box = shapes[0];
  return shapes.length === 1 && box && box.every((value, index) => value === (index < 3 ? 0 : 1))
    ? placement.expectedCells[0]
    : null;
}

/** Shared full-cell occupancy check for planning and the final placement attempt. */
export function occupiedCell(bot: Bot, cell: Position3 | null, ignoreEntityId?: number): string | null {
  if (!cell) return null;
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === ignoreEntityId) continue;
    const mob = entity.name && bot.registry.entitiesByName[entity.name]?.metadataKeys?.includes("mob_flags");
    if (!entity.isValid || (entity.type !== "player" && !mob)) continue;
    if (
      entity.type === "player" &&
      (entity.id === bot.entity.id
        ? bot.game.gameMode === "spectator"
        : bot.players[entity.username ?? ""]?.gamemode === 3)
    )
      continue;
    if (cellIntersectsBody(cell, entity))
      return `Placement cell (${cell.x}, ${cell.y}, ${cell.z}) overlaps ${entity.name ?? entity.type} #${entity.id} at (${entity.position.x}, ${entity.position.y}, ${entity.position.z}).`;
  }
  return null;
}

/** Equip, orient, sneak, place against one support face, and verify the resulting block. */
export async function placeBlock(bot: Bot, placement: BlockPlacement): Promise<BlockPlacementResult> {
  const face = asVec3(placement.face);
  const placementBot = bot as PlacementOptionsBot;
  let blockUpdateTimeout: string | null = null;
  const consumesItem = bot.game.gameMode !== "creative";
  const inventoryBefore = consumesItem ? carriedCount(bot, placement.item.name) : 0;
  const cubeCell = fullCubeCell(bot, placement);

  try {
    placement.signal?.throwIfAborted();
    const initialBlocker = occupiedCell(bot, cubeCell);
    if (initialBlocker) return { kind: "failed", error: initialBlocker };
    await bot.equip(placement.item, "hand");

    if (placement.lookDirection) {
      const direction = placement.lookDirection;
      const yaw = Math.atan2(-direction.x, -direction.z);
      await bot.look(yaw, 0);
    } else if (placementBot._placeBlockWithOptions) {
      // Aim once, then check the bodies observed at the instant we will send the placement.
      await bot.lookAt(placement.support.position.offset(0.5 + face.x / 2, 0.5 + face.y / 2, 0.5 + face.z / 2), true);
    }

    placement.signal?.throwIfAborted();
    const currentBlocker = occupiedCell(bot, cubeCell);
    if (currentBlocker) return { kind: "failed", error: currentBlocker };
    setSneaking(bot, true);
    await placeWithoutLooking(bot, placement.support, face);
  } catch (cause) {
    if (placement.signal?.aborted) throw cause;
    if (!isBlockUpdateTimeout(cause)) return { kind: "failed", error: message(cause) };
    blockUpdateTimeout = message(cause);
  } finally {
    setSneaking(bot, false);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const placedBlocks = placement.expectedCells.map((position) => bot.blockAt(asVec3(position)));
    if (placedBlocks.every((block): block is WorldBlock => Boolean(block && placement.matches(block)))) {
      if (consumesItem) {
        // The block update precedes the slot update. Returning between them
        // let a builder select the just-emptied stack for its next placement.
        const inventory = await settleInventoryCount(bot, placement.item.name, inventoryBefore - 1, {
          signal: placement.signal,
        });
        placement.signal?.throwIfAborted();
        if (!inventory.confirmed) {
          return {
            kind: "failed",
            error: `The block appeared, but consumption of ${placement.item.name} was not observed (inventory ${inventoryBefore} → ${inventory.count}).`,
          };
        }
      }
      recordCombatResourceReceipt(bot, { kind: "scaffold_placed" });
      return { kind: "placed", block: placedBlocks[0] };
    }

    if (attempt < 4) {
      try {
        await bot.waitForTicks(1);
        placement.signal?.throwIfAborted();
      } catch (cause) {
        if (placement.signal?.aborted) throw cause;
        return { kind: "failed", error: message(cause) };
      }
    }
  }

  if (blockUpdateTimeout) {
    return {
      kind: "failed",
      error: `${blockUpdateTimeout}; physical verification after 5 ticks observed ${observedCells(bot, placement)}.`,
    };
  }

  return { kind: "failed", error: "The expected block did not appear after placement." };
}

/** The six cells a block can be placed against, floor first so a seal lands the way a player would build it. */
const SEAL_SUPPORTS: readonly Vec3[] = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/** Put one carried full block into a named cell, whatever replaceable thing that cell holds. */
export type PlaceIntoCell = (
  bot: Bot,
  cell: Position3,
  options?: { readonly signal?: AbortSignal },
) => Promise<BlockPlacementResult>;

export function isSolid(block: WorldBlock | null): block is WorldBlock {
  return block?.boundingBox === "block";
}

/** A support and the face pointing from it into the requested cell. */
export interface PlacementSupport {
  readonly support: WorldBlock;
  readonly face: Vec3;
}

/** Find a supporting neighbour, preferring the floor. Material selection belongs to the caller. */
export function findPlacementSupport(
  bot: Bot,
  cell: Position3,
  accepts: (block: WorldBlock) => boolean = isSolid,
): PlacementSupport | null {
  const position = asVec3(cell);
  for (const offset of SEAL_SUPPORTS) {
    const support = bot.blockAt(position.plus(offset));
    if (support && accepts(support)) return { support, face: offset.scaled(-1) };
  }
  return null;
}

/** Carried items that are full solid blocks: what a seal or a pour cell can be made of. */
export function carriedSolidBlocks(bot: Bot): InventoryItem[] {
  return bot.inventory
    .items()
    .filter((item) => bot.registry.blocksByName[item.name]?.boundingBox === "block")
    .sort((left, right) => right.count - left.count);
}

/**
 * Fill a cell with the caller's selected solid block and verify the placement.
 * Material selection stays with the caller so preparing a mining target cannot
 * silently spend the very items that collection is trying to gain.
 */
export async function placeSolidBlockInto(
  bot: Bot,
  cell: Position3,
  item: InventoryItem | null,
  options: { readonly signal?: AbortSignal } = {},
): Promise<BlockPlacementResult> {
  const position = asVec3(cell);
  const current = bot.blockAt(position);
  if (!current) return { kind: "failed", error: "The cell is not loaded." };
  if (current.boundingBox === "block") return { kind: "placed", block: current };
  if (!isReplaceableForPlacement(current)) {
    return { kind: "failed", error: `The cell holds ${current.name}, which a placement does not replace.` };
  }
  if (!item) return { kind: "failed", error: "No permitted full block is available for placement." };
  const support = findPlacementSupport(bot, position);
  if (!support) return { kind: "failed", error: "Nothing solid beside the cell to place against." };
  return placeBlock(bot, {
    item,
    ...support,
    expectedCells: [{ x: position.x, y: position.y, z: position.z }],
    matches: isSolid,
    ...(options.signal && { signal: options.signal }),
  });
}
