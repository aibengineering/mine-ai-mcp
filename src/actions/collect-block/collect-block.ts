import { collectCheckpointSchema } from "../checkpoint-schemas.js";
import { hasInventorySpaceFor } from "../../world/inventory-capacity.js";
/**
 * `collect_block`: ask the mine process for a quantity, and report what
 * the inventory actually gained.
 *
 * Everything physical belongs to the pathfinder. Choosing targets, pricing
 * routes, breaking blocks, and walking onto dropped items are one process there
 * — Baritone's `MineProcess` — so this file owns only the MCP contract: what
 * was requested, whether the bot may fill its inventory doing it, and what the
 * run is worth reporting afterwards.
 */
import "@aibengineering/minecraft-block-highlighter";
import type { BlockCollection } from "@aibengineering/minecraft-block-highlighter";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { LOADED_SEARCH_RADIUS } from "../../navigation/processes/mining/block-exploration.js";
import {
  mine,
  type MinecraftBlock,
  type MineResult,
  type MineTarget,
} from "../../navigation/processes/mining/mine-process.js";
import { evaluateMineTarget, type MineTargetDecision } from "../../navigation/processes/mining/target-safety.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { asVec3 } from "../../utils/index.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { droppedItemName } from "../../world/item-pickup.js";
import { useItemAt } from "../../world/item-use.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import { carriedSolidBlocks, placeSolidBlockInto } from "../../world/placement.js";
import { defineAction, type ActionContext } from "../action.js";
import { blockMatchesSelector, expectedDropName, inventoryCounts, inventoryGains } from "./collection-facts.js";
import { createCollectionMovements } from "./collection-movements.js";
import {
  cellLabel,
  decimal,
  HIGHLIGHT_COLOURS,
  HIGHLIGHT_HOLD_MS,
  MAX_EXTRA_BREAKS,
  outcomes,
  parseCollectBlockRequest,
  COLLECT_BLOCK,
  COLLECT_BLOCK_DESCRIPTION,
  collectBlockInputSchema,
  collectBlockResultSchema,
  type BrokenCell,
  type CollectBlockRequest,
  type CollectBlockResult,
} from "./contract.js";

const sumValues = (record: Record<string, number>): number => Object.values(record).reduce((total, n) => total + n, 0);

// ── Action preparation ────────────────────────────────────────────────────────────────────

/**
 * Every block name this request would accept, which is also every block whose
 * drop counts as a gain. Silk touch changes what a block yields, so this is
 * read once with the tool the bot is actually holding.
 */
interface CollectionTarget {
  readonly itemNames: ReadonlySet<string>;
  readonly blockStateIds: ReadonlySet<number>;
}

function collectionTarget(bot: Bot, request: CollectBlockRequest): CollectionTarget {
  const matching = Object.keys(bot.registry?.blocksByName ?? {}).filter((name) =>
    blockMatchesSelector(name, request.selector),
  );
  const names = matching.length > 0 ? matching : [request.selector];
  // The block's own name is kept alongside its drop because a silk-touch break
  // yields the block itself, and the gain filter must accept either.
  const itemNames = new Set(names.flatMap((name) => [name, expectedDropName(bot, name)]));
  const blockStateIds = new Set<number>();
  for (const name of matching) {
    const block = bot.registry.blocksByName[name]!;
    for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) blockStateIds.add(stateId);
  }
  return { itemNames, blockStateIds };
}

function collectionMovements(bot: Bot, request: CollectBlockRequest, target: CollectionTarget) {
  // Matching blocks are deliberately not protected from breaking. Mining is
  // pathing: the goal is the target's own cell, so the route has to break it to
  // arrive. Extra breaks on the way are priced by `breakPenalty` and counted by
  // the mine process, rather than being forbidden.
  return createCollectionMovements(bot, {
    protectedBlockNames: [],
    // What the run is collecting must not be spent building scaffold to reach
    // the rest of it.
    protectedScaffoldNames: [...target.itemNames],
    matchingStateIds: target.blockStateIds,
    exactTarget: request.exactTarget,
    scaffolding: request.scaffolding,
  });
}

export function inventoryStop(
  bot: Bot,
  request: CollectBlockRequest,
  itemNames: ReadonlySet<string>,
): string | null {
  if (request.allowFullInventory) return null;
  if (hasInventorySpaceFor(bot.inventory, itemNames)) return null;
  const totalSlots = bot.inventory.inventoryEnd - bot.inventory.inventoryStart;
  return outcomes.inventoryFull(totalSlots, [...itemNames]);
}

/**
 * The capacity check while the process runs. Admission can only ask about the
 * whole matching set, and for a selector like `logs` a spare birch slot answers
 * for every other wood. Once the process is walking to a live drop the question
 * is whether *that* item can enter. Asked of the set instead, a bot with room
 * for birch stood on an oak log until the server despawned it, mined another,
 * and stood on that one too.
 */
export function pursuedInventoryStop(
  bot: Bot,
  request: CollectBlockRequest,
  collectable: ReadonlySet<string>,
  pursued: readonly MineTarget[],
): string | null {
  const dropped = new Set<string>();
  for (const target of pursued) {
    if (target.kind !== "drop") continue;
    const entity = bot.entities[target.entityId];
    const name = entity === undefined ? null : droppedItemName(entity);
    if (name !== null && collectable.has(name)) dropped.add(name);
  }
  return inventoryStop(bot, request, dropped.size > 0 ? dropped : collectable);
}

/**
 * Why a named cell cannot be the target, asked before mining rather than
 * discovered by walking there. A request without coordinates has nothing to
 * check: the mine process finds what is there and prunes what it cannot break.
 */
function exactTargetStop(
  bot: Bot,
  request: CollectBlockRequest,
  canMine: (block: MinecraftBlock) => MineTargetDecision,
): string | null {
  if (!request.exactTarget) return null;
  const target = asVec3(request.exactTarget).floored();
  const block = bot.blockAt(target);
  if (!block || !blockMatchesSelector(block.name, request.selector)) {
    return outcomes.targetMismatch(request.exactTarget, block?.name ?? "unloaded", request.selector);
  }
  const decision = canMine(block);
  return decision.kind === "mineable" ? null : outcomes.unmineable(block.name, block.position, decision.reason);
}

// ── Action execution ──────────────────────────────────────────────────────────────────────

export async function collectBlock(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CollectBlockRequest,
  context: ActionContext,
  discarded: DiscardedItems = createDiscardedItems(),
): Promise<CollectBlockResult> {
  const lifetime = new AbortController();
  try { return await beginCollectBlock(bot, navigation, request, discarded, () => {}, lifetime.signal)(context); }
  finally { lifetime.abort("Collection request settled."); }
}

function beginCollectBlock(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CollectBlockRequest,
  discarded: DiscardedItems,
  observe: ObserveRequest = () => {},
  lifetime?: AbortSignal,
) {
  const inventoryBefore = inventoryCounts(bot);
  const start = bot.entity.position.clone();
  const target = collectionTarget(bot, request);
  const collectable = target.itemNames;
  const broken: MineResult["broken"][number][] = [];
  const toolLoss = observeToolTierLoss(bot);
  lifetime?.addEventListener("abort", () => toolLoss.close(), { once: true });
  observe(() => ({
    baseline: { ...inventoryBefore },
    checkpoint: {
      broken: broken.length,
      gained: sumValues(inventoryGains(bot, inventoryBefore, collectable)),
      requested: request.requested,
    },
    completion: {
      kind: "current",
      observed: sumValues(inventoryGains(bot, inventoryBefore, collectable)) >= request.requested,
      owes: `Net inventory gain of ${request.requested} collectible items still carried at settlement.`,
    },
  }));
  return async (context: ActionContext): Promise<CollectBlockResult> => {
    context.signal?.throwIfAborted();
    const gained = () => sumValues(inventoryGains(bot, inventoryBefore, collectable));
    if (gained() >= request.requested) {
      return settle(bot, request, inventoryBefore, collectable, start, { status: "satisfied", broken, reason: null });
    }
    const movements = collectionMovements(bot, request, target);
    // Preparation and its lava-face budget use the same live material selection.
    // Items counted toward this request are reserved, just as they are for scaffold.
    const buildingBlocks = () => carriedSolidBlocks(bot).filter((item) => !collectable.has(item.name));
    const canMine = (block: MinecraftBlock) =>
      evaluateMineTarget(
        bot,
        movements,
        block,
        navigation.world,
        buildingBlocks().reduce((count, item) => count + item.count, 0),
      );
    const stop = inventoryStop(bot, request, collectable) ?? exactTargetStop(bot, request, canMine);
    if (stop) {
      return settle(bot, request, inventoryBefore, collectable, start, { status: "stopped", broken, reason: stop });
    }

    const exactCell = request.exactTarget ? asVec3(request.exactTarget).floored() : null;

    // Admission can leave only part of the requested quantity free. Once pickups
    // fill that space, release the route instead of waiting at a live drop until
    // Minecraft despawns it. Check on physics ticks after inventory packets
    // settle, against the drop the process is actually walking to.
    const capacity = new AbortController();
    let capacityReason: string | null = null;
    let pursued: readonly MineTarget[] = [];
    const checkCapacity = () => {
      if (gained() >= request.requested || capacity.signal.aborted) return;
      capacityReason = pursuedInventoryStop(bot, request, collectable, pursued);
      if (capacityReason !== null) capacity.abort(new Error(capacityReason));
    };
    bot.on("physicsTick", checkCapacity);
    try {
      const result = await mine(bot, {
        ignoredDropIds: discarded.ignored(),
        route: (options) => navigation.navigate({ ...options, onToolSelected: toolLoss.select }),
        breakInPlace: (options) => navigation.breakBlockInPlace({ ...options, onToolSelected: toolLoss.select }),
        placeInto: (placementBot, cell, options) =>
          placeSolidBlockInto(placementBot, cell, buildingBlocks()[0] ?? null, options),
        // Obsidian is the one block the bot can make rather than find: water onto
        // a lava source. The process makes pools targets only when it has nothing
        // to mine and water in the bucket.
        cast: blockMatchesSelector("obsidian", request.selector) ? useItemAt : null,
        matches: (block: MinecraftBlock) => blockMatchesSelector(block.name, request.selector),
        canMine,
        matchingStateIds: target.blockStateIds,
        ...(exactCell !== null && { exactTarget: exactCell }),
        collects: (itemName) => collectable.has(itemName),
        isSatisfied: () => gained() >= request.requested,
        observedInventoryGain: gained,
        movements,
        castSearchRadius: LOADED_SEARCH_RADIUS,
        explore: exactCell === null,
        maximumBreaks: Math.max(0, request.requested + MAX_EXTRA_BREAKS - broken.length),
        signal: AbortSignal.any([...(context.signal ? [context.signal] : []), capacity.signal]),
        ...(request.onToolLoss === "stop" && { stopSignal: toolLoss.signal }),
        onTargets: (targets) => {
          pursued = targets;
          return showTargets(bot, targets);
        },
        onBroken: (position) => broken.push(position),
      });

      return settle(
        bot, request, inventoryBefore, collectable, start,
        capacityReason === null ? { ...result, broken } : { status: "stopped", broken, reason: capacityReason },
      );
    } catch (error) {
      context.signal?.throwIfAborted();
      if (capacityReason === null || error !== capacity.signal.reason) throw error;
      return settle(bot, request, inventoryBefore, collectable, start, { status: "stopped", broken, reason: capacityReason });
    } finally {
      bot.off("physicsTick", checkCapacity);
    }
  };
}

/** Publish this pass's target set for anyone watching the world. */
async function showTargets(bot: Bot, targets: readonly MineTarget[]): Promise<void> {
  const blocks = targets
    .map((target) => bot.blockAt(asVec3(target.position)))
    .filter((block): block is MinecraftBlock => block !== null);
  if (blocks.length === 0) return;
  const collection: BlockCollection<MinecraftBlock> = blocks.toHighlightableBlocks();
  await collection.highlight(HIGHLIGHT_COLOURS.candidate, {
    label: `Mining: ${targets.length} target${targets.length === 1 ? "" : "s"} offered to the pathfinder`,
    holdMs: HIGHLIGHT_HOLD_MS,
  });
}

// ── Result settlement ─────────────────────────────────────────────────────────────────────

/** Why the mine process stopped, in the words of the request that asked for it. */
function stopReason(request: CollectBlockRequest, result: MineResult, gained: number): string | null {
  switch (result.status) {
    case "satisfied":
      return null;
    case "no_targets":
      return outcomes.noLoadedTargets(request.selector);
    case "unreachable":
      return outcomes.targetsUnreachable(request.selector, result.reason ?? "no route was found");
    case "exhausted":
      return outcomes.dropAttemptsExhausted(result.broken.length, gained, request.requested);
    case "stopped":
      return result.reason ?? outcomes.incomplete;
  }
}

export function settle(
  bot: Bot,
  request: CollectBlockRequest,
  inventoryBefore: Record<string, number>,
  collectable: ReadonlySet<string>,
  start: Vec3,
  result: MineResult,
): CollectBlockResult {
  const gainedByItem = inventoryGains(bot, inventoryBefore, collectable);
  const gained = sumValues(gainedByItem);
  // Quantity is observed here; the process also owns completing any cast's
  // pending water recovery. Inventory alone must not hide that failed work.
  const bucketNames = ["bucket", "water_bucket", "lava_bucket"];
  const bucketsBefore = bucketNames.reduce((count, name) => count + (inventoryBefore[name] ?? 0), 0);
  const after = inventoryCounts(bot);
  const bucketsAfter = bucketNames.reduce((count, name) => count + (after[name] ?? 0), 0);
  const missingBucket = blockMatchesSelector("obsidian", request.selector) && bucketsAfter < bucketsBefore;
  const met = gained >= request.requested && result.status === "satisfied" && !missingBucket;
  const status = met ? "succeeded" : gained > 0 || result.broken.length > 0 ? "partial" : "failed";
  // Where the blocks came from is the one thing a count cannot say. The
  // nearest match may be a deposit sixty blocks down or the frame the bot just
  // built beside itself, and only the cells tell those apart.
  const brokenAt: BrokenCell[] = result.broken.map((cell) => ({
    x: cell.x,
    y: cell.y,
    z: cell.z,
    distanceFromStart: decimal(asVec3(cell).offset(0.5, 0.5, 0.5).distanceTo(start)),
  }));
  const collected = { requested: request.requested, gained, gainedByItem, blocksBroken: brokenAt.length, brokenAt };
  if (status === "succeeded") return { status, collected };
  return {
    status,
    error: outcomes.progress(
      missingBucket
        ? `[CASTING_BUCKET_MISSING] Carried buckets decreased from ${bucketsBefore} to ${bucketsAfter}; the missing bucket was not recovered.`
        : (stopReason(request, result, gained) ?? outcomes.incomplete),
      gained,
      request.requested,
      brokenAt.length,
    ),
    collected,
  };
}

// ── Action definition ─────────────────────────────────────────────────────────────────────

export function formatCollectBlockResult(result: CollectBlockResult): string {
  const { collected } = result;
  const gains = Object.entries(collected.gainedByItem)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([item, count]) => `  - \`${item}\`: ${count}`)
    .join("\n");
  const brokenAt = collected.brokenAt
    .map((cell) => `  - ${cellLabel(cell)} (${cell.distanceFromStart} blocks from the start)`)
    .join("\n");
  const evidence = [
    `- Requested: ${collected.requested}`,
    `- Inventory gained: ${collected.gained}`,
    `- Matching blocks broken: ${collected.blocksBroken}`,
    ...(brokenAt ? [brokenAt] : []),
    "- Gains by item:",
    gains || "  - None observed",
  ].join("\n");
  return result.status === "succeeded" ? evidence : `${evidence}\n\n**Observed stop:** ${result.error}`;
}

/** Bind the bot this action controls while keeping the shared action contract dependency-free. */
export function createCollectBlockAction(
  bot: Bot,
  navigation: NavigationRuntime,
  discarded: DiscardedItems = createDiscardedItems(),
) {
  return defineAction({
    checkpointSchema: collectCheckpointSchema,
    name: COLLECT_BLOCK,
    description: COLLECT_BLOCK_DESCRIPTION,
    inputSchema: collectBlockInputSchema,
    resultSchema: collectBlockResultSchema,
    formatResult: formatCollectBlockResult,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: {
      title: COLLECT_BLOCK,
      destructiveHint: true,
      openWorldHint: true,
    },
    parse: parseCollectBlockRequest,
    begin: (request, lifetime, observe) => beginCollectBlock(bot, navigation, request, discarded, observe, lifetime),
  });
}
