import { bucketDropTotals } from "../../navigation/mineflayer/water-landing.js";
import { navigateCheckpointSchema } from "../checkpoint-schemas.js";
/** Navigate once, then report the position the world actually yielded. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  canOccupyWater,
  createMovements,
  nearGoal,
  nearXzGoal,
  type Goal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { scaffoldBlockNames } from "../../navigation/mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { isSafeSupport, navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { asVec3, type Position3 } from "../../utils/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import {
  navigateOutcomes,
  parseNavigateRequest,
  NAVIGATE,
  NAVIGATE_DESCRIPTION,
  navigateInputSchema,
  navigateResultSchema,
  type NavigationEvidence,
  type NavigateRequest,
  type NavigateResult,
} from "./contract.js";

export interface NavigateDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
}

function productionDependencies(navigate: Navigate): NavigateDependencies {
  return { createMovements, navigate };
}

function position(value: Position3): Position3 {
  return { x: value.x, y: value.y, z: value.z };
}

/** How far below a target to look for ground when refusing it, so the refusal can name the height instead. */
const GROUND_SEARCH_DEPTH = 64;

function passable(bot: Bot, cell: Vec3): boolean {
  const block = bot.blockAt(cell);
  return block !== null && block.boundingBox === "empty" && block.name !== "water" && block.name !== "lava";
}

function supported(bot: Bot, feet: Vec3): boolean {
  const block = bot.blockAt(feet.offset(0, -1, 0));
  return block !== null && isSafeSupport(observeMineflayerBlock(block));
}

/** Feet and head clear, and something solid to stand on. Unloaded cells are not standable. */
function standable(bot: Bot, feet: Vec3): boolean {
  return passable(bot, feet) && passable(bot, feet.offset(0, 1, 0)) && supported(bot, feet);
}

/**
 * Reject unsupported mid-air destinations unless building was requested.
 * Existing footing is enough: movement policy owns whether feet and head
 * cells can be excavated. Unloaded targets must be judged during the route.
 */
function targetSupported(bot: Bot, target: { x: number; y: number; z: number }, range: number): boolean {
  const centre = new Vec3(target.x, target.y, target.z);
  if (bot.blockAt(centre) === null) return true;
  const reach = Math.ceil(range);
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dz = -reach; dz <= reach; dz += 1) {
        const feet = centre.offset(dx, dy, dz);
        if (feet.distanceTo(centre) <= range && (supported(bot, feet) || canOccupyWater(bot, feet))) return true;
      }
    }
  }
  return false;
}

/** How far around a watery target the existing shore search looks. */
const SHORE_SEARCH_RADIUS = 8;

type SurfaceObservation =
  | { readonly kind: "surface"; readonly y: number; readonly name: string; readonly solid: boolean }
  | { readonly kind: "ambiguous"; readonly observation: string };

/** Omitted height may resolve only an unambiguous outdoor column, never choose among floors. */
function surfaceAt(bot: Bot, x: number, z: number): SurfaceObservation | null {
  // The game plugin supplies these dimension bounds; Mineflayer's type omits them.
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  const bottom = dimension.minY;
  const top = bottom + dimension.height - 1;
  let highest: Extract<SurfaceObservation, { kind: "surface" }> | null = null;
  const floors: number[] = [];
  for (let y = top; y >= bottom; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (block.boundingBox !== "block" && block.name !== "water" && block.name !== "lava") continue;
    highest ??= { kind: "surface", y, name: block.name, solid: block.boundingBox === "block" };
    if (y + 2 <= top && standable(bot, new Vec3(x, y + 1, z))) floors.push(y + 1);
  }
  if (highest && (highest.name.endsWith("_leaves") || highest.name === "bedrock" || floors.length > 1)) {
    return {
      kind: "ambiguous",
      observation: `[NAVIGATION_HEIGHT_REQUIRED] Column ${x}, ${z} has highest block ${highest.name} at y=${highest.y}; observed standable feet heights: ${floors.join(", ") || "none"}. Supply y to choose a floor.`,
    };
  }
  return highest;
}

/**
 * Where a ground target on water is really going: the nearest column within
 * a few blocks whose surface is solid ground the bot can stand on. Both
 * bucket deaths in the playthroughs began with a walk to "the water at x,z",
 * which the ground goal resolved to the lake bed.
 */
function shoreNear(bot: Bot, target: { x: number; z: number }): { x: number; z: number } | null {
  const surface = surfaceAt(bot, target.x, target.z);
  if (!surface || surface.kind === "ambiguous" || surface.solid) return target;
  for (let radius = 1; radius <= SHORE_SEARCH_RADIUS; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = target.x + dx;
        const z = target.z + dz;
        const candidate = surfaceAt(bot, x, z);
        if (candidate?.kind === "surface" && candidate.solid && standable(bot, new Vec3(x, candidate.y + 1, z)))
          return { x, z };
      }
    }
  }
  return null;
}

/** The highest standable feet cell at or below the target in its column, if one is loaded. */
function groundBelow(bot: Bot, target: { x: number; y: number; z: number }): number | null {
  for (let y = target.y; y >= target.y - GROUND_SEARCH_DEPTH; y -= 1) {
    if (standable(bot, new Vec3(target.x, y, target.z))) return y;
  }
  return null;
}

function scaffoldStocks(bot: Bot, before: ReadonlyMap<string, number>) {
  return [...before.keys()].map((item) => {
    const itemId = bot.registry.itemsByName[item]?.id;
    const inventoryBefore = before.get(item) ?? 0;
    const inventoryAfter = itemId === undefined ? 0 : bot.inventory.count(itemId, null);
    return { item, inventoryBefore, inventoryAfter, consumed: Math.max(0, inventoryBefore - inventoryAfter) };
  });
}

function navigationEvidence(
  bot: Bot,
  request: NavigateRequest,
  start: Position3,
  startDimension: string,
  elapsedMs: number,
  scaffoldInventoryBefore: ReadonlyMap<string, number>,
  bucketBefore: ReturnType<typeof bucketDropTotals>,
): NavigationEvidence {
  const target = { x: request.x, y: request.y, z: request.z };
  // GoalNear settles integral path nodes rather than the entity's fractional
  // centre, so the postcondition measures that same node. An unresolved
  // surface has only a horizontal distance and can never report success.
  const endBlock = asVec3(navigationFeet(bot.entity.position, bot.entity.onGround));
  const remainingDistance =
    bot.game.dimension !== startDimension
      ? null
      : request.y === null
        ? Math.hypot(endBlock.x - request.x, endBlock.z - request.z)
        : endBlock.distanceTo(asVec3({ x: request.x, y: request.y, z: request.z }));
  return {
    startDimension,
    endDimension: bot.game.dimension,
    target,
    range: request.range,
    start,
    end: position(bot.entity.position),
    remainingDistance,
    elapsedMs,
    scaffolding: scaffoldStocks(bot, scaffoldInventoryBefore),
    bucketDrops: { count: bucketDropTotals(bot).count - bucketBefore.count, waterRecovered: bucketDropTotals(bot).waterRecovered - bucketBefore.waterRecovered },
    missingDigTools: request.dig
      ? (["shovel", "pickaxe", "axe"] as const).filter(
          (tool) => !bot.inventory.items().some((item) => item.name.endsWith(`_${tool}`)),
        )
      : [],
  };
}

/** Execute one standard Pathfinder route without imposing an arbitrary distance timeout. */
export async function navigate(
  bot: Bot,
  request: NavigateRequest,
  context: ActionContext,
  dependencies: NavigateDependencies,
): Promise<NavigateResult> {
  const lifetime = new AbortController();
  try {
    return await beginNavigate(bot, request, dependencies, lifetime.signal)(context);
  } finally {
    lifetime.abort("Navigation request settled.");
  }
}

function beginNavigate(
  bot: Bot,
  request: NavigateRequest,
  dependencies: NavigateDependencies,
  lifetime: AbortSignal,
  observe: ObserveRequest = () => {},
) {
  const toolLoss = request.dig ? observeToolTierLoss(bot) : null;
  lifetime.addEventListener("abort", () => toolLoss?.close(), { once: true });
  const start = position(bot.entity.position);
  const startDimension = bot.game.dimension;
  const bucketBefore = bucketDropTotals(bot);
  const scaffoldInventoryBefore = new Map(
    scaffoldBlockNames(bot).map((item) => [item, bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null)]),
  );
  let elapsedMs = 0;
  let destination = request.y === null ? null : { x: request.x, y: request.y, z: request.z };
  observe(() => ({
    baseline: { dimension: startDimension, position: { ...start } },
    checkpoint: {
      destination,
      remainingDistance: destination && bot.game.dimension === startDimension
        ? bot.entity.position.distanceTo(asVec3(destination)) : null,
      dimension: bot.game.dimension,
      positionedDimension: startDimension,
      died: false,
      portal: null,
    },
    completion: {
      kind: "current",
      observed:
        destination !== null &&
        bot.game.dimension === startDimension &&
        asVec3(navigationFeet(bot.entity.position, bot.entity.onGround)).distanceTo(asVec3(destination)) <=
          request.range &&
        (bot.entity.onGround || canOccupyWater(bot, navigationFeet(bot.entity.position, bot.entity.onGround))),
      owes: "Current destination distance and supported footing or admitted water.",
    },
  }));
  const portalProblem = (): string | null => {
    if (!destination || bot.game.dimension !== startDimension) return null;
    const cell = asVec3(destination);
    const block = bot.blockAt(cell);
    return block?.name === "end_portal" || block?.name === "nether_portal"
      ? `[NAVIGATION_PORTAL_INTENT_REQUIRED] Use ${block.name === "end_portal" ? "enter_end_portal" : "enter_nether_portal"} to enter this active portal.`
      : null;
  };
  return async (context: ActionContext): Promise<NavigateResult> => {
    const startedAt = Date.now();
    context.signal?.throwIfAborted();
    const problem = portalProblem();
    if (problem)
      return {
        status: "failed",
        error: problem,
        navigation: navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore),
      };
    if (bot.game.dimension !== startDimension) {
      const evidence = navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore);
      return {
        status: "failed",
        error: navigateOutcomes.dimensionChanged(startDimension, bot.game.dimension),
        navigation: evidence,
      };
    }
    if (
      request.y !== null &&
      !request.build &&
      !targetSupported(bot, { x: request.x, y: request.y, z: request.z }, request.range)
    ) {
      const target = { x: request.x, y: request.y, z: request.z };
      return {
        status: "failed",
        error: navigateOutcomes.unsupportedTarget(target, request.range, groundBelow(bot, target)),
        navigation: navigationEvidence(bot, request, start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore),
      };
    }
    let route: NavigationResult;

    // Keep an unloaded surface unresolved while approaching its column. Once
    // observed, freeze the actual destination, including height, for both search
    // and the final receipt. Horizontal proximity alone never completes it.
    const evidenceRequest = () => (destination ? { ...request, ...destination } : request);
    const goal: Goal = {
      resolve(observation) {
        if (destination === null) {
          const surface = surfaceAt(bot, request.x, request.z);
          if (surface === null) {
            const approach = nearXzGoal(request, request.range).resolve(observation);
            return approach.kind === "active" ? { ...approach, isSatisfied: () => false } : approach;
          }
          if (surface.kind === "ambiguous") return { kind: "invalid", observation: surface.observation };
          const shore = shoreNear(bot, request);
          if (!shore)
            return { kind: "invalid", observation: navigateOutcomes.targetOnWater(request, SHORE_SEARCH_RADIUS) };
          const ground = surfaceAt(bot, shore.x, shore.z);
          if (!ground || ground.kind === "ambiguous" || !standable(bot, new Vec3(shore.x, ground.y + 1, shore.z))) {
            return { kind: "invalid", observation: "No standable surface was observed in the destination column." };
          }
          destination = { x: shore.x, y: ground.y + 1, z: shore.z };
        }
        const problem = portalProblem();
        if (problem) return { kind: "invalid", observation: problem };
        return nearGoal(destination, request.range).resolve(observation);
      },
    };

    try {
      route = await dependencies.navigate({
        movements: dependencies.createMovements(bot, { scaffolding: request.scaffold, allowDigging: request.dig }),
        goal,
        signal: context.signal,
        ...(toolLoss && { stopSignal: toolLoss.signal }),
        ...(toolLoss && { onToolSelected: toolLoss.select }),
      });
      const lost = toolLoss?.loss();
      if (lost) {
        elapsedMs += Date.now() - startedAt;
        return { status: "partial", error: lost.reason, navigation: navigationEvidence(
          bot, evidenceRequest(), start, startDimension, elapsedMs, scaffoldInventoryBefore, bucketBefore,
        ) };
      }
    } catch (cause) {
      elapsedMs += Date.now() - startedAt;
      // Navigation settles its controls and can report an unrestored doorway.
      // Preserve that evidence when propagating the action's cancellation.
      if (context.signal?.aborted) throw cause;
      return {
        status: "failed",
        error: navigateOutcomes.executionFailed(cause),
        navigation: navigationEvidence(
          bot,
          evidenceRequest(),
          start,
          startDimension,
          elapsedMs,
          scaffoldInventoryBefore,
          bucketBefore,
        ),
      };
    }

    elapsedMs += route.elapsedMs;
    const evidence = navigationEvidence(
      bot,
      evidenceRequest(),
      start,
      startDimension,
      elapsedMs,
      scaffoldInventoryBefore,
      bucketBefore,
    );
    if (evidence.endDimension !== evidence.startDimension) {
      return {
        status: "failed",
        error: navigateOutcomes.dimensionChanged(evidence.startDimension, evidence.endDimension),
        navigation: evidence,
      };
    }
    if (route.status === "stopped") {
      return { status: "failed", error: navigateOutcomes.stopped(route.reason), navigation: evidence };
    }
    if (destination === null) {
      return {
        status: "failed",
        error:
          "[NAVIGATION_SURFACE_UNOBSERVED] The destination surface was not observed; horizontal proximity is not arrival.",
        navigation: evidence,
      };
    }
    if (evidence.remainingDistance !== null && evidence.remainingDistance > request.range) {
      return {
        status: "failed",
        error: navigateOutcomes.incomplete(evidence.remainingDistance, request.range),
        navigation: evidence,
      };
    }
    return { status: "succeeded", navigation: evidence };
  };
}

export function formatNavigateResult(result: NavigateResult): string {
  const { navigation } = result;
  const evidence = [
    navigation.remainingDistance === null
      ? `Dimension changed from \`${navigation.startDimension}\` to \`${navigation.endDimension}\`; distance to the source-world target does not apply.`
      : `Final Pathfinder node is **${navigation.remainingDistance.toFixed(2)} blocks** from the target; requested range is **${navigation.range} blocks** in \`${navigation.endDimension}\`.`,
    `- Target: \`${navigation.target.x}, ${navigation.target.y ?? "ground"}, ${navigation.target.z}\``,
    `- Start: \`${navigation.start.x.toFixed(2)}, ${navigation.start.y.toFixed(2)}, ${navigation.start.z.toFixed(2)}\``,
    `- End: \`${navigation.end.x.toFixed(2)}, ${navigation.end.y.toFixed(2)}, ${navigation.end.z.toFixed(2)}\``,
    `- Pathfinder elapsed: ${navigation.elapsedMs} ms`,
    "- Scaffold stocks:",
    ...navigation.scaffolding.map(
      ({ item, inventoryBefore, inventoryAfter, consumed }) =>
        `  - ${item}: ${inventoryBefore} → ${inventoryAfter} (used ${consumed})`,
    ),
  ].join("\n");
  const outcome = result.status === "succeeded" ? evidence : `${evidence}\n\n**Observed stop:** ${result.error}`;
  return navigation.missingDigTools.length === 0
    ? outcome
    : `${outcome}\n\n**Warning:** Missing ${navigation.missingDigTools.join(", ")}. Navigation may be slow and inefficient.`;
}

export function createNavigateAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: NavigateDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: navigateCheckpointSchema,
    name: NAVIGATE,
    description: NAVIGATE_DESCRIPTION,
    inputSchema: navigateInputSchema,
    resultSchema: navigateResultSchema,
    formatResult: formatNavigateResult,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: {
      title: NAVIGATE,
      destructiveHint: true,
      openWorldHint: true,
    },
    parse: parseNavigateRequest,
    begin: (request, lifetime, observe) => beginNavigate(bot, request, dependencies, lifetime, observe),
  });
}
