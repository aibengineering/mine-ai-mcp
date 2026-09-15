import { dropCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Vec3 } from "vec3";
import type { BreakBlockInPlace } from "../../navigation/execution/in-place-break.js";
import {
  createMovements,
  customGoal,
  HORIZONTAL_TICKS_PER_BLOCK,
  nearEntityGoal,
  type Navigate,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { carriedCount, settleInventoryCount } from "../../world/inventory-count.js";
import { droppedItemName, snapshotEntityIds } from "../../world/item-pickup.js";
import { placeSolidBlockInto } from "../../world/placement.js";
import { defineAction, type ActionContext } from "../action.js";
import { equipmentSlots } from "../equip/index.js";
import { describeNavigation } from "../navigation-result.js";
import {
  dropItemAnnotations,
  dropItemOutcomes,
  NEVER_DROPPED_SLOTS,
  parseDropItemRequest,
  DROP_ITEM,
  DROP_ITEM_DESCRIPTION,
  dropItemInputSchema,
  dropItemResultSchema,
  type DropItemEvidence,
  type DroppedItem,
  type DropRecipient,
  type DropItemRequest,
  type DropItemResult,
  type HoleClosure,
} from "./contract.js";
import {
  DisposalHoleError,
  observeHoleDrops,
  prepareDisposalHole,
  sealDisposalHole,
  snapshotDroppedCounts,
} from "./disposal-hole.js";

/**
 * How long a toss is given to clear the slot it emptied.
 *
 * A toss is a server round trip: the slot clears when the server acknowledges
 * it, not when the promise resolves. Mining settles observed drops on the same
 * budget (`OBSERVED_DROP_SETTLE_MS`), which is longer than the couple of ticks
 * a receipt normally waits, because a drop that never lands must be reported
 * as not observed rather than merely unconfirmed.
 */
const TOSS_SETTLE_MS = 1_500;

/** How close the bot gets before handing items over. Within this, a toss lands at their feet. */
const HANDOVER_RANGE = 2;

/** A tossed item lands within a couple of blocks; anything further appeared for another reason. */
const DISCARD_ATTRIBUTION_RADIUS = 4;

/**
 * How far, in the plane, the bot ends a hole drop from the hole's column.
 *
 * Three blocks puts the whole rim between the bot and the pit, so the next
 * request's route starts from open ground rather than from the lip.
 */
const HOLE_CLEARANCE = 3;

export interface DropItemDependencies {
  readonly navigate: Navigate;
  readonly breakInPlace: BreakBlockInPlace;
  /** Fills one cell of the hole's shaft with a carried block once the toss is done. */
  readonly placeInto: typeof placeSolidBlockInto;
  readonly createMovements: (bot: Bot) => ReturnType<typeof createMovements>;
  /** How long the server gets to show a toss in the inventory and, for a hole, on the ground. */
  readonly settleMs?: number;
}

function productionDependencies(navigation: NavigationRuntime): DropItemDependencies {
  return {
    navigate: navigation.navigate,
    breakInPlace: navigation.breakBlockInPlace,
    placeInto: placeSolidBlockInto,
    createMovements,
  };
}

const stacksOf = (bot: Bot, itemName: string): Item[] => bot.inventory.items().filter((item) => item.name === itemName);

/** The equipment slot wearing this item, when it is one this action refuses to drop. */
function wornSlot(bot: Bot, itemName: string): string | null {
  const slots = equipmentSlots(bot);
  const byName: Record<(typeof NEVER_DROPPED_SLOTS)[number], string | null> = {
    head: slots.head,
    torso: slots.torso,
    legs: slots.legs,
    feet: slots.feet,
    "off-hand": slots.offHand,
  };
  return NEVER_DROPPED_SLOTS.find((slot) => byName[slot] === itemName) ?? null;
}

/**
 * Toss one item, then confirm the inventory actually lost it.
 *
 * `bot.toss` throws for a count larger than one stack, so a partial count is
 * spread over the stacks that hold it and whole stacks go through `tossStack`.
 */
async function tossItem(
  bot: Bot,
  itemName: string,
  requested: number | null,
  context: ActionContext,
  settleMs: number,
): Promise<DroppedItem> {
  const carriedBefore = carriedCount(bot, itemName);
  if (carriedBefore === 0) {
    return {
      item: itemName,
      requested,
      carriedBefore: 0,
      carriedAfter: 0,
      dropped: 0,
      error: dropItemOutcomes.notCarried(itemName),
    };
  }

  let remaining = requested ?? carriedBefore;
  try {
    for (const stack of stacksOf(bot, itemName)) {
      if (remaining <= 0) break;
      context.signal?.throwIfAborted();
      if (remaining >= stack.count) {
        await bot.tossStack(stack);
        remaining -= stack.count;
      } else {
        await bot.toss(stack.type, null, remaining);
        remaining = 0;
      }
    }
  } catch (cause) {
    context.signal?.throwIfAborted();
    const carriedAfter = carriedCount(bot, itemName);
    return {
      item: itemName,
      requested,
      carriedBefore,
      carriedAfter,
      dropped: carriedBefore - carriedAfter,
      error: dropItemOutcomes.rejected(itemName, cause),
    };
  }

  const expected = requested ?? carriedBefore;
  const settled = await settleInventoryCount(bot, itemName, Math.max(0, carriedBefore - expected), {
    timeoutMs: settleMs,
    signal: context.signal,
  });
  context.signal?.throwIfAborted();

  const carriedAfter = settled.count;
  const dropped = carriedBefore - carriedAfter;
  return dropped >= expected
    ? { item: itemName, requested, carriedBefore, carriedAfter, dropped }
    : {
        item: itemName,
        requested,
        carriedBefore,
        carriedAfter,
        dropped,
        error: dropItemOutcomes.notObserved(itemName, carriedAfter),
      };
}

class DropItemActionError extends Error {}

/** Walk to the named player and face them, so a toss lands at their feet rather than ours. */
async function approachPlayer(
  bot: Bot,
  name: string,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<DropRecipient> {
  const entity: Entity | undefined = bot.players[name]?.entity;
  if (!entity) throw new DropItemActionError(dropItemOutcomes.playerNotFound(name));

  if (bot.entity.position.distanceTo(entity.position) > HANDOVER_RANGE) {
    const route = await dependencies
      .navigate({
        movements: dependencies.createMovements(bot),
        goal: nearEntityGoal({ id: entity.id }, HANDOVER_RANGE),
        signal: context.signal,
      })
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new DropItemActionError(dropItemOutcomes.playerUnreachable(name, reason), { cause });
      });

    // The goal tracks a live entity, so a player who walks off invalidates it.
    const arrived = bot.players[name]?.entity;
    if (!arrived) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
    if (bot.entity.position.distanceTo(arrived.position) > HANDOVER_RANGE) {
      throw new DropItemActionError(dropItemOutcomes.playerUnreachable(name, describeNavigation(route)));
    }
  }

  const target = bot.players[name]?.entity;
  if (!target) throw new DropItemActionError(dropItemOutcomes.playerLeft(name));
  await bot.lookAt(target.position);
  return {
    name,
    distance: Number(bot.entity.position.distanceTo(target.position).toFixed(2)),
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
  };
}

/**
 * Mark the items this toss created so no sweep picks them straight back up.
 *
 * Only entities that appeared during the toss and are close enough to have come
 * from it are attributed to it. Metadata can arrive a tick after the entity, so
 * an item whose name is not yet readable is still claimed: an unattributed
 * discard is worse than a slightly wide one, and the memory expires anyway.
 */
function rememberDiscards(bot: Bot, baseline: ReadonlySet<number>, discarded: DiscardedItems): void {
  const ids = Object.values(bot.entities)
    .filter((entity) => !baseline.has(entity.id))
    .filter((entity) => entity.position.distanceTo(bot.entity.position) <= DISCARD_ATTRIBUTION_RADIUS)
    .filter((entity) => droppedItemName(entity) !== null || entity.name === "item")
    .map((entity) => entity.id);
  discarded.remember(ids);
}

/** Walk clear of the hole so the next request's route does not start beside, or in, the pit. */
async function stepAwayFromHole(
  bot: Bot,
  hole: Vec3,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<{ distance: number; error?: string }> {
  const column = { x: hole.x + 0.5, z: hole.z + 0.5 };
  const distanceFrom = (position: { x: number; z: number }) =>
    Math.hypot(position.x - column.x, position.z - column.z);
  const goal = customGoal(
    `clear-of-hole:${hole.x},${hole.y},${hole.z}`,
    (node) => distanceFrom({ x: node.feet.x + 0.5, z: node.feet.z + 0.5 }) >= HOLE_CLEARANCE,
    (node) =>
      Math.max(0, HOLE_CLEARANCE - distanceFrom({ x: node.feet.x + 0.5, z: node.feet.z + 0.5 })) *
      HORIZONTAL_TICKS_PER_BLOCK,
  );
  try {
    const route = await dependencies.navigate({
      movements: dependencies.createMovements(bot),
      goal,
      signal: context.signal,
    });
    const distance = Number(distanceFrom(bot.entity.position).toFixed(2));
    return distance >= HOLE_CLEARANCE
      ? { distance }
      : { distance, error: `[DROP_HOLE_BESIDE] Still ${distance} blocks from the hole: ${describeNavigation(route)}` };
  } catch (cause) {
    context.signal?.throwIfAborted();
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      distance: Number(distanceFrom(bot.entity.position).toFixed(2)),
      error: `[DROP_HOLE_BESIDE] Could not step back from the hole: ${reason}`,
    };
  }
}

/**
 * Plug the pit and step back from it.
 *
 * A collect request issued straight after a hole drop routed the bot back
 * into the open pit it had just tossed into. Neither step changes the drop's
 * outcome, so both report into the evidence rather than the status.
 */
async function closeDisposalHole(
  bot: Bot,
  hole: Vec3,
  dependencies: DropItemDependencies,
  context: ActionContext,
): Promise<HoleClosure> {
  const seal = await sealDisposalHole(bot, hole, dependencies.placeInto, context);
  const retreat = await stepAwayFromHole(bot, hole, dependencies, context);
  const errors = [seal.error, retreat.error].filter((error): error is string => error !== undefined);
  return {
    item: seal.item,
    placed: seal.placed,
    distance: retreat.distance,
    ...(errors.length > 0 && { error: errors.join(" ") }),
  };
}

export async function dropItem(
  bot: Bot,
  request: DropItemRequest,
  context: ActionContext,
  dependencies: DropItemDependencies,
  discarded: DiscardedItems,
): Promise<DropItemResult> {
  context.signal?.throwIfAborted();
  const freeSlotsBefore = bot.inventory.emptySlotCount();
  const progressItems = request.items.map((item) => ({ item: item.itemName, requested: item.count ?? carriedCount(bot, item.itemName), before: carriedCount(bot, item.itemName) }));
  context.observeProgress?.(() => ({ baseline: { freeSlots: freeSlotsBefore },
    checkpoint: { phase: "disposing", freeSlots: bot.inventory.emptySlotCount(), items: progressItems.map((item) => ({
      ...item, current: carriedCount(bot, item.item), removed: item.before - carriedCount(bot, item.item),
    })) },
    completion: { kind: "event", observed: false, owes: "Requested items removed and destination delivery or disposal cleanup confirmed." },
  }));
  const entityBaseline = snapshotEntityIds(bot);
  // Digging may select a shovel or pickaxe. Protection refers to the caller's
  // held item, not the tool the hole preparation temporarily selected.
  const heldName = bot.heldItem?.name;

  let recipient: DropRecipient | null = null;
  let hole: Vec3 | null = null;
  if (request.destination.kind !== "ground") {
    try {
      if (request.destination.kind === "player") {
        recipient = await approachPlayer(bot, request.destination.name, dependencies, context);
      } else {
        hole = await prepareDisposalHole(bot, dependencies.createMovements(bot), dependencies.breakInPlace, context);
      }
    } catch (cause) {
      context.signal?.throwIfAborted();
      if (!(cause instanceof DropItemActionError) && !(cause instanceof DisposalHoleError)) throw cause;
      return {
        status: "failed",
        error: cause.message,
        drop: {
          dropped: [],
          freeSlotsBefore,
          freeSlotsAfter: bot.inventory.emptySlotCount(),
          droppedAt: { ...bot.entity.position },
          recipient: null,
          hole,
          holeClosure: null,
        },
      };
    }
  }

  const holeBaseline = hole ? snapshotDroppedCounts(bot) : new Map<number, number>();
  const dropped: DroppedItem[] = [];
  for (const { itemName, count } of request.items) {
    context.signal?.throwIfAborted();

    const worn = wornSlot(bot, itemName);
    if (worn) {
      dropped.push({
        item: itemName,
        requested: count,
        carriedBefore: carriedCount(bot, itemName),
        carriedAfter: carriedCount(bot, itemName),
        dropped: 0,
        error: dropItemOutcomes.worn(itemName, worn),
      });
      continue;
    }
    if (!request.allowEquipped && (request.destination.kind === "hole" ? heldName : bot.heldItem?.name) === itemName) {
      dropped.push({
        item: itemName,
        requested: count,
        carriedBefore: carriedCount(bot, itemName),
        carriedAfter: carriedCount(bot, itemName),
        dropped: 0,
        error: dropItemOutcomes.held(itemName),
      });
      continue;
    }

    dropped.push(await tossItem(bot, itemName, count, context, dependencies.settleMs ?? TOSS_SETTLE_MS));
  }

  // Claim what this toss put on the ground so the hunt's sweep leaves it alone.
  if (dropped.some((entry) => entry.dropped > 0)) rememberDiscards(bot, entityBaseline, discarded);

  // Free slots and the toss position are read now: plugging the hole spends a
  // block and stepping back moves the body, and neither is part of the drop.
  const freeSlotsAfter = bot.inventory.emptySlotCount();
  const droppedAt = { ...bot.entity.position };
  let landed = true;
  let holeClosure: HoleClosure | null = null;
  if (hole) {
    landed = await observeHoleDrops(bot, hole, holeBaseline, dropped, context, dependencies.settleMs ?? TOSS_SETTLE_MS);
    context.signal?.throwIfAborted();
    // Whether or not the toss was seen at the bottom, an open pit beside the
    // bot is the hazard the next route walks into, so close it either way.
    holeClosure = await closeDisposalHole(bot, hole, dependencies, context);
  }

  const evidence: DropItemEvidence = {
    dropped,
    freeSlotsBefore,
    freeSlotsAfter,
    droppedAt,
    recipient,
    hole,
    holeClosure,
  };

  if (!landed) {
    return {
      status: "failed",
      error:
        "[DROP_HOLE_CONTENTS_NOT_OBSERVED] The inventory changed, but not all tossed items were observed at the bottom of the hole.",
      drop: evidence,
    };
  }
  const failed = dropped.filter((entry) => entry.error).length;
  if (failed === 0) return { status: "succeeded", drop: evidence };
  return {
    status: failed === dropped.length ? "failed" : "partial",
    error: dropItemOutcomes.incomplete(failed, dropped.length),
    drop: evidence,
  };
}

export function formatDropItemResult(result: DropItemResult): string {
  const { drop } = result;
  const lines = drop.dropped.map((entry) =>
    entry.error
      ? `- Could not drop **${entry.item}**: ${entry.error}`
      : `- Dropped **${entry.item}** x${entry.dropped} (carried ${entry.carriedBefore} → ${entry.carriedAfter}).`,
  );

  const at = drop.droppedAt;
  lines.push(
    "",
    drop.recipient
      ? `Handed to **${drop.recipient.name}** from ${drop.recipient.distance} blocks away, at \`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\`.`
      : `Dropped at \`${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)}\`.`,
    `Free slots ${drop.freeSlotsBefore} → ${drop.freeSlotsAfter}.`,
  );
  if (drop.hole) {
    lines.push(`Disposal hole bottom: \`${drop.hole.x}, ${drop.hole.y}, ${drop.hole.z}\` (two blocks deep).`);
    const closure = drop.holeClosure;
    if (closure) {
      lines.push(
        closure.placed > 0
          ? `Plugged the hole with ${closure.placed} ${closure.item}; now standing ${closure.distance} blocks from it.`
          : `The hole is still open; the bot stands ${closure.distance} blocks from it.`,
      );
      if (closure.error) lines.push(`**Hole not fully closed:** ${closure.error}`);
    }
  } else if (drop.dropped.some((entry) => !entry.error)) {
    lines.push("Dropped items despawn after about five minutes and this bot may pick them up again if it stays close.");
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createDropItemAction(
  bot: Bot,
  navigation: NavigationRuntime,
  discarded: DiscardedItems = createDiscardedItems(),
  dependencies: DropItemDependencies = productionDependencies(navigation),
) {
  return defineAction({
    checkpointSchema: dropCheckpointSchema,
    name: DROP_ITEM,
    description: DROP_ITEM_DESCRIPTION,
    inputSchema: dropItemInputSchema,
    resultSchema: dropItemResultSchema,
    formatResult: formatDropItemResult,
    execution: { kind: "task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: dropItemAnnotations,
    parse: parseDropItemRequest,
    execute: (request, context) => dropItem(bot, request, context, dependencies, discarded),
  });
}
