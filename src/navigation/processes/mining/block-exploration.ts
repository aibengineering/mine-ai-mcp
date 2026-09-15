import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { cellKey } from "../../../utils/index.js";
import { findLoadedBlockPositions } from "../../../world/loaded-block-scan.js";
import {
  ASCENT_TICKS_PER_BLOCK,
  customGoal,
  DESCENT_TICKS_PER_BLOCK,
  HORIZONTAL_TICKS_PER_BLOCK,
  type BlockPosition,
  type Goal,
  type MovementPolicy,
  type Navigate,
} from "../../index.js";

/**
 * Baritone's no-known-ore fallback: keep moving away from one remembered
 * branch point while tending back toward its Y level. It never reports
 * arrival; newly scanned targets replace it as the live goal.
 */
export function branchMiningGoal(branchPoint: BlockPosition): Goal {
  return customGoal(
    `mine-branch:${cellKey(branchPoint)}`,
    () => false,
    (node) => {
      const horizontal =
        Math.hypot(node.feet.x - branchPoint.x, node.feet.z - branchPoint.z) * HORIZONTAL_TICKS_PER_BLOCK;
      const dy = branchPoint.y - node.feet.y;
      const vertical = dy > 0 ? dy * ASCENT_TICKS_PER_BLOCK : -dy * DESCENT_TICKS_PER_BLOCK;
      return vertical * 1.5 - horizontal * 0.6;
    },
  );
}

/** How often the loaded columns are rescanned while the bot explores, in ticks. */
const EXPLORATION_RESCAN_TICKS = 20;
/** Horizontal radius whose loaded columns are searched through their full height, unless a caller narrows it. */
export const LOADED_SEARCH_RADIUS = 64;
/** How long exploring for a block nothing loaded shows may go on before the caller is told to decide. */
export const EXPLORATION_MAXIMUM_MS = 90_000;

export interface BlockExplorationRequest {
  readonly stateIds: ReadonlySet<number>;
  /** Horizontal radius whose loaded columns are searched; the whole loaded neighbourhood by default. */
  readonly searchRadius?: number;
  readonly movements: MovementPolicy;
  readonly route: Navigate;
  /** A bound on walking after nothing the scan can find; the caller decides what to do then. */
  readonly maximumMs?: number;
  readonly signal?: AbortSignal;
}

export type BlockExplorationResult =
  | { readonly kind: "found"; readonly positions: readonly Vec3[]; readonly explored: boolean }
  | { readonly kind: "none"; readonly reason: string };

function scan(bot: Bot, request: BlockExplorationRequest): Vec3[] {
  const from = bot.entity.position;
  return findLoadedBlockPositions(bot, {
    center: from,
    radius: request.searchRadius ?? LOADED_SEARCH_RADIUS,
    stateIds: request.stateIds,
    limit: 256,
  })
    .map((position) => position.clone())
    .sort((left, right) => left.distanceTo(from) - right.distanceTo(from));
}

/**
 * Find blocks in the loaded world, exploring outward when none is loaded.
 *
 * The scan is the one mining uses; the exploration is the branch the mine
 * process follows when its own scan comes up empty. Anything that needs a
 * block it cannot see - ore, lava, water - asks here rather than growing its
 * own way of looking, and what to do when the bound is reached is left to
 * the caller, which is to say to the model.
 */
export async function exploreForBlocks(bot: Bot, request: BlockExplorationRequest): Promise<BlockExplorationResult> {
  const loaded = scan(bot, request);
  if (loaded.length > 0) return { kind: "found", positions: loaded, explored: false };

  const feet = bot.entity.position.floored();
  const enough = new AbortController();
  let ticks = 0;
  const watch = () => {
    ticks += 1;
    if (ticks % EXPLORATION_RESCAN_TICKS === 0 && scan(bot, request).length > 0) enough.abort("target loaded");
  };
  bot.on("physicsTick", watch);
  let stopped: string | null = null;
  try {
    const route = await request.route({
      movements: request.movements,
      goal: branchMiningGoal({ x: feet.x, y: feet.y, z: feet.z }),
      timeoutMs: request.maximumMs ?? EXPLORATION_MAXIMUM_MS,
      signal: request.signal,
      stopSignal: enough.signal,
      onCalculationFailure: async ({ failure }) => {
        stopped = `no route to explore along: ${failure.kind}`;
        return { kind: "completed" };
      },
    });
    if (route.status === "stopped" && !enough.signal.aborted) stopped = route.reason;
  } finally {
    bot.off("physicsTick", watch);
  }
  const found = scan(bot, request);
  if (found.length > 0) return { kind: "found", positions: found, explored: true };
  return { kind: "none", reason: stopped ?? "explored for the whole bound without a match" };
}
