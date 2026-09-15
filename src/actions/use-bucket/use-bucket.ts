import { bucketCheckpointSchema } from "../checkpoint-schemas.js";
/**
 * `use_bucket`: scoop a source, or pour a full bucket into a cell.
 *
 * The server decides what a bucket hits by casting a ray from the eyes, so
 * the action's work is choosing what to look at. For a fill that is the
 * source block itself: an empty bucket's ray stops only at source liquid. For
 * a pour it is whatever `pourAim` says lands in the named cell, because a full
 * bucket's ray ignores liquid, stops at the first solid face, and pours into
 * the cell in front of it. Everything else is reach, confirmation, and
 * counting what the liquid did once it landed.
 *
 * Making obsidian is not here. Casting water onto lava is how obsidian is
 * obtained, so it belongs to the process that obtains blocks: the mine
 * process pours when it has nothing to mine and lava in range, and
 * `collect_block obsidian` is the one way to ask for it.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  canAccessLiquid,
  createMovements,
  liquidAccessGoal,
  nearGoal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
  type WorldView,
} from "../../navigation/index.js";
import { exploreForBlocks } from "../../navigation/processes/mining/block-exploration.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import {
  countFormations,
  isLiquidSource,
  isReplaceableForPlacement,
  observedEyeHeight,
  pourAim,
  settledFormations,
  sourceFeeding,
  useItemAt,
  type ItemUseResult,
} from "../../world/index.js";
import { defineAction, type ActionContext } from "../action.js";
import {
  parseUseBucketRequest,
  USE_BUCKET,
  USE_BUCKET_DESCRIPTION,
  useBucketInputSchema,
  useBucketResultSchema,
  useBucketAnnotations,
  useBucketOutcomes,
  type BucketCell,
  type BucketLiquid,
  type BucketUseEvidence,
  type UseBucketRequest,
  type UseBucketResult,
} from "./contract.js";

/**
 * How close a pour walks to its cell, feet cell to cell.
 *
 * Two, not the four the ray allows, because the ray is cast from the eye at a
 * face on the *far* side of the cell: from four blocks back the aim point is
 * over five away and the server refuses it before anything else is asked.
 */
const POUR_APPROACH_RANGE = 2;
export interface UseBucketDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly useItem: typeof useItemAt;
  /** The loaded scan with the mine process's exploration behind it: where every source is found. */
  readonly explore: typeof exploreForBlocks;
  readonly world: WorldView;
}

function productionDependencies(navigation: NavigationRuntime): UseBucketDependencies {
  return {
    createMovements,
    navigate: navigation.navigate,
    useItem: useItemAt,
    explore: exploreForBlocks,
    world: navigation.world,
  };
}

function coordinates(position: Vec3): BucketCell {
  return { x: position.x, y: position.y, z: position.z };
}

function bucketFor(liquid: BucketLiquid, full: boolean): string {
  return full ? `${liquid}_bucket` : "bucket";
}

function carried(bot: Bot, name: string) {
  return bot.inventory.items().find((item) => item.name === name) ?? null;
}

interface SourceSearch {
  readonly sources: readonly Vec3[];
  readonly reason: string | null;
  readonly explored: boolean;
}

/**
 * Source blocks of the liquid, nearest first, from the exploration primitive:
 * the loaded scan mining uses, then the walk mining takes when nothing is
 * loaded. A bound, not a promise: when it runs out the result says so and the
 * model decides where to look next.
 */
async function findSources(
  bot: Bot,
  liquid: BucketLiquid,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<SourceSearch> {
  const definition = bot.registry.blocksByName[liquid];
  if (!definition) return { sources: [], reason: `Minecraft has no block named ${liquid}.`, explored: false };
  const result = await dependencies.explore(bot, {
    stateIds: new Set([definition.minStateId]),
    movements: dependencies.createMovements(bot),
    route: dependencies.navigate,
    signal: context.signal,
  });
  if (result.kind !== "found") return { sources: [], reason: result.reason, explored: true };
  return { sources: result.positions, reason: null, explored: result.explored };
}

async function approach(
  bot: Bot,
  target: Vec3,
  context: ActionContext,
  dependencies: UseBucketDependencies,
  range: number,
): Promise<NavigationResult | null> {
  // Measured feet cell to cell, as `nearGoal` measures arrival, so the two agree.
  if (bot.entity.position.floored().distanceTo(target) <= range) return null;
  return dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: nearGoal(coordinates(target), range),
    signal: context.signal,
  });
}

/** Navigation owns the stance, route excavation, and sightline to any discovered source. */
async function approachVisibleSource(
  bot: Bot,
  sources: readonly Vec3[],
  liquid: BucketLiquid,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<{ readonly source: Vec3 } | { readonly error: string }> {
  const usableSource = () =>
    bot.entity.onGround && Reflect.get(bot.entity, "isInWater") !== true && Reflect.get(bot.entity, "isInLava") !== true
      ? sources.find((source) =>
          canAccessLiquid(dependencies.world, bot.entity.position, source, liquid, observedEyeHeight(bot.entity)),
        )
      : undefined;
  const current = usableSource();
  if (current) return { source: current };
  const route = await dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: liquidAccessGoal(sources, liquid),
    signal: context.signal,
  });
  if (route.status === "stopped") return { error: useBucketOutcomes.routeStopped(route.reason) };
  const source = usableSource();
  return source ? { source } : { error: useBucketOutcomes.noLineOfSight };
}

interface Attempt {
  readonly request: UseBucketRequest;
  readonly target: Vec3 | null;
  readonly targetBefore: string | null;
  readonly heldBefore: string | null;
  aimedAt?: Vec3;
  obsidian: number;
  cobblestone: number;
  used: boolean;
  explored?: boolean;
}

function evidence(bot: Bot, attempt: Attempt): BucketUseEvidence {
  return {
    dimension: bot.game.dimension,
    action: attempt.request.action,
    liquid: attempt.request.liquid,
    target: attempt.target ? coordinates(attempt.target) : null,
    targetBefore: attempt.targetBefore,
    targetAfter: attempt.target ? (bot.blockAt(attempt.target)?.name ?? null) : null,
    ...(attempt.aimedAt && { aimedAt: coordinates(attempt.aimedAt.floored()) }),
    heldBefore: attempt.heldBefore,
    heldAfter: bot.heldItem?.name ?? null,
    obsidianFormed: attempt.obsidian,
    cobblestoneFormed: attempt.cobblestone,
    used: attempt.used,
    ...(attempt.explored !== undefined && { explored: attempt.explored }),
  };
}

function failure(bot: Bot, attempt: Attempt, error: string): UseBucketResult {
  return { status: "failed", error, bucket: evidence(bot, attempt) };
}

/**
 * Why a named cell cannot be what it was named for, asked before the walk.
 *
 * Run 10 named a flowing cell for a fill and the action walked five seconds to
 * it, digging with the pickaxe on the way, before reading the block and
 * refusing it. A cell that is already wrong is wrong now — and flowing liquid
 * is fed by a source, which a model naming a cell it saw the liquid in is
 * usually a few cells downstream of.
 */
function namedCell(
  bot: Bot,
  request: Extract<UseBucketRequest, { action: "fill" | "pour" }>,
  target: Vec3,
): { readonly target: Vec3 } | { readonly error: string } {
  const block = bot.blockAt(target);
  // Not loaded yet: the walk itself is what makes the cell readable.
  if (!block) return { target };
  if (request.action === "pour") {
    return isReplaceableForPlacement(block) ? { target } : { error: useBucketOutcomes.targetOccupied(block.name) };
  }
  if (isLiquidSource(bot, block, request.liquid)) return { target };
  const feeding = block.name === request.liquid ? sourceFeeding(bot, target, request.liquid) : null;
  return feeding ? { target: feeding } : { error: useBucketOutcomes.notASource(request.liquid, block.name) };
}

type BucketTarget =
  | { readonly kind: "ready"; readonly target: Vec3; readonly explored: boolean }
  | { readonly kind: "failed"; readonly target: Vec3 | null; readonly explored: boolean; readonly error: string };

/** Resolve coordinates or a discovery into the same visible, dry fill approach. */
async function resolveBucketTarget(
  bot: Bot,
  request: UseBucketRequest,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<BucketTarget> {
  const namedTarget = request.cell ? new Vec3(request.cell.x, request.cell.y, request.cell.z) : null;
  const search: SourceSearch = namedTarget
    ? { sources: [namedTarget], reason: null, explored: false }
    : await findSources(bot, request.liquid, context, dependencies);
  const failed = (error: string): BucketTarget => ({
    kind: "failed",
    target: namedTarget,
    explored: search.explored,
    error,
  });
  if (search.sources.length === 0) return failed(useBucketOutcomes.noSource(request.liquid, search.reason));
  let sources = search.sources;
  if (namedTarget) {
    const named = namedCell(bot, request, namedTarget);
    if ("error" in named) return failed(named.error);
    sources = [named.target];
  }
  try {
    if (request.action === "fill") {
      const reached = await approachVisibleSource(bot, sources, request.liquid, context, dependencies);
      return "error" in reached
        ? failed(reached.error)
        : { kind: "ready", target: reached.source, explored: search.explored };
    }
    const target = sources[0]!;
    const route = await approach(bot, target, context, dependencies, POUR_APPROACH_RANGE);
    return route?.status === "stopped"
      ? failed(useBucketOutcomes.routeStopped(route.reason))
      : { kind: "ready", target, explored: search.explored };
  } catch (cause) {
    context.signal?.throwIfAborted();
    return failed(useBucketOutcomes.routeStopped(cause instanceof Error ? cause.message : String(cause)));
  }
}

/** Scoop a source or pour a full bucket, and report only what was observed. */
export async function useBucket(
  bot: Bot,
  request: UseBucketRequest,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<UseBucketResult> {
  const filling = request.action === "fill";
  const bucketName = bucketFor(request.liquid, !filling);
  const heldBefore = bot.heldItem?.name ?? null;
  const item = carried(bot, bucketName);
  const attempt: Attempt = {
    request,
    target: request.cell ? new Vec3(request.cell.x, request.cell.y, request.cell.z) : null,
    targetBefore: null,
    heldBefore,
    obsidian: 0,
    cobblestone: 0,
    used: false,
  };
  let observed = attempt;
  context.observeProgress?.(() => ({ baseline: { held: heldBefore },
    checkpoint: { phase: observed.used ? "confirmed" : filling ? "finding_and_filling" : "approaching_and_pouring", held: bot.heldItem?.name ?? null,
      target: observed.target ? { x: observed.target.x, y: observed.target.y, z: observed.target.z } : null,
      targetBlock: observed.target ? bot.blockAt(observed.target)?.name ?? null : null, used: observed.used,
      obsidianFormed: observed.obsidian, cobblestoneFormed: observed.cobblestone },
    completion: { kind: "event", observed: observed.used, owes: "Both the bucket inventory and the selected world cell must confirm the use." },
  }));
  if (!item) return failure(bot, attempt, useBucketOutcomes.noBucket(bucketName));

  const resolved = await resolveBucketTarget(bot, request, context, dependencies);
  if (resolved.kind === "failed") {
    return failure(bot, { ...attempt, target: resolved.target, explored: resolved.explored }, resolved.error);
  }
  const { target } = resolved;
  attempt.explored = resolved.explored;
  const placed: Attempt = { ...attempt, target, targetBefore: bot.blockAt(target)?.name ?? null };
  observed = placed;

  const targetBlock = bot.blockAt(target);
  if (!targetBlock) return failure(bot, placed, useBucketOutcomes.targetUnloaded);

  let use: ItemUseResult;
  if (filling) {
    if (!isLiquidSource(bot, targetBlock, request.liquid)) {
      return failure(bot, placed, useBucketOutcomes.notASource(request.liquid, targetBlock.name));
    }
    // Aim at the source's surface, not its centre: from four blocks back a
    // ray to the centre dips into the shore block just before the water.
    use = await dependencies.useItem(bot, {
      item,
      lookAt: target.offset(0.5, 0.9, 0.5),
      expectedInventoryGain: { item: bucketFor(request.liquid, true), count: 1 },
      signal: context.signal,
    });
  } else {
    if (!isReplaceableForPlacement(targetBlock)) {
      return failure(bot, placed, useBucketOutcomes.targetOccupied(targetBlock.name));
    }
    // The same question the cast asks: where would a pour from here land? The
    // named cell is the only answer this action accepts.
    const aim = pourAim(bot, (landing) => (landing.equals(target) ? 1 : null));
    if (!aim) return failure(bot, placed, useBucketOutcomes.noFace);
    placed.aimedAt = aim.surface;
    const before = countFormations(bot, target);
    use = await dependencies.useItem(bot, {
      item,
      lookAt: aim.lookAt,
      expectedCells: [{ position: target, matches: (block) => block.name === request.liquid }],
      expectedHeldItem: "bucket",
      signal: context.signal,
    });
    if (use.kind === "used") {
      const after = await settledFormations(bot, target, context.signal);
      placed.obsidian = Math.max(0, after.obsidian - before.obsidian);
      placed.cobblestone = Math.max(0, after.cobblestone - before.cobblestone);
    }
  }
  if (use.kind === "failed") return failure(bot, placed, useBucketOutcomes.failed(use.error));
  placed.used = true;
  return { status: "succeeded", bucket: evidence(bot, placed) };
}

export function formatUseBucketResult(result: UseBucketResult): string {
  const { bucket } = result;
  const target = bucket.target ? `\`${bucket.target.x}, ${bucket.target.y}, ${bucket.target.z}\`` : "no cell";
  const summary = !bucket.used
    ? `Did not ${bucket.action} the bucket.`
    : bucket.action === "fill"
      ? `Filled the bucket with **${bucket.liquid}** from ${target}.`
      : `Poured **${bucket.liquid}** into ${target}.`;
  const lines = [
    summary,
    `- Hand: \`${bucket.heldBefore ?? "empty"}\` → \`${bucket.heldAfter ?? "empty"}\` in \`${bucket.dimension}\``,
    `- Target: \`${bucket.targetBefore ?? "unloaded"}\` → \`${bucket.targetAfter ?? "unloaded"}\``,
  ];
  if (bucket.aimedAt) lines.push(`- Aimed at: \`${bucket.aimedAt.x}, ${bucket.aimedAt.y}, ${bucket.aimedAt.z}\``);
  if (bucket.action === "pour" && bucket.used) {
    lines.push(`- Formed: ${bucket.obsidianFormed} obsidian, ${bucket.cobblestoneFormed} cobblestone`);
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createUseBucketAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: UseBucketDependencies = productionDependencies(navigation),
) {
  return defineAction({
    checkpointSchema: bucketCheckpointSchema,
    name: USE_BUCKET,
    description: USE_BUCKET_DESCRIPTION,
    inputSchema: useBucketInputSchema,
    resultSchema: useBucketResultSchema,
    formatResult: formatUseBucketResult,
    execution: { kind: "task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: useBucketAnnotations,
    parse: parseUseBucketRequest,
    execute: (request, context) => useBucket(bot, request, context, dependencies),
  });
}
