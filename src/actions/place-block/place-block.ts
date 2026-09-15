import { placeCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  createMovements,
  nearGoal,
  type Goal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { cellIntersectsPlayerBody, cellKey } from "../../utils/index.js";
import {
  carriedCount,
  isReplaceableForPlacement,
  placeBlock,
  placeCarriedBlockNearby,
  settledNow,
  settleInventoryCount,
  type BlockPlacementResult,
  type SettledInventoryCount,
  type WorldBlock,
} from "../../world/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { unconfirmedCount } from "../markdown.js";
import {
  parsePlaceBlockRequest,
  placeBlockAnnotations,
  placeBlockOutcomes,
  placeBlockOutcomesNearby,
  PLACE_BLOCK,
  PLACE_BLOCK_DESCRIPTION,
  placeBlockInputSchema,
  placeBlockResultSchema,
  type BlockPlacementEvidence,
  type PlaceBlockRequest,
  type PlaceBlockResult,
} from "./contract.js";

const PLACEMENT_REACH = 4;

const SUPPORT_DIRECTIONS = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
] as const;

export interface PlaceBlockDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly placeBlock: (bot: Bot, placement: Parameters<typeof placeBlock>[1]) => Promise<BlockPlacementResult>;
  readonly placeNearby: typeof placeCarriedBlockNearby;
}

function productionDependencies(navigate: Navigate): PlaceBlockDependencies {
  return { createMovements, navigate, placeBlock, placeNearby: placeCarriedBlockNearby };
}

function coordinates(position: Vec3): { x: number; y: number; z: number } {
  return { x: position.x, y: position.y, z: position.z };
}

function evidence(
  bot: Bot,
  request: PlaceBlockRequest,
  target: Vec3,
  inventoryBefore: number,
  beforeBlock: string | null,
  support?: { block: WorldBlock; face: Vec3 },
  placed = false,
  /** The settled count, on the paths that put a block down. */
  after: SettledInventoryCount = settledNow(bot, request.blockName),
): BlockPlacementEvidence {
  return {
    dimension: bot.game.dimension,
    requestedBlock: request.blockName,
    target: coordinates(target),
    beforeBlock,
    afterBlock: bot.blockAt(target)?.name ?? null,
    inventoryBefore,
    inventoryAfter: after.count,
    confirmed: after.confirmed,
    placed,
    ...(support && { support: coordinates(support.block.position), face: coordinates(support.face) }),
  };
}

function findSupport(bot: Bot, target: Vec3): { block: WorldBlock; face: Vec3 } | null {
  for (const candidate of SUPPORT_DIRECTIONS) {
    const block = bot.blockAt(target.plus(candidate.offset));
    if (block?.boundingBox === "block") return { block, face: candidate.face };
  }
  return null;
}

async function approachTarget(
  bot: Bot,
  target: Vec3,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
): Promise<NavigationResult | null> {
  if (
    bot.entity.position.distanceTo(target) <= PLACEMENT_REACH &&
    !cellIntersectsPlayerBody(target, bot.entity.position)
  ) {
    return null;
  }
  // The goal is the whole reach, not a tighter ring: a target four blocks up a
  // wall is reachable from the floor beneath it, and asking for closer left
  // only cells inside the wall, which the route then planned to dig.
  const reach = nearGoal({ x: target.x, y: target.y, z: target.z }, PLACEMENT_REACH);
  const goal: Goal = {
    resolve(observation) {
      const resolved = reach.resolve(observation);
      if (resolved.kind !== "active") return resolved;
      const currentCell = cellKey(navigationFeet(observation.position, observation.stance === "supported"));
      const obstructed = cellIntersectsPlayerBody(target, observation.position);
      return {
        ...resolved,
        revision: `placement-clear:${resolved.revision}:${obstructed ? currentCell : "clear"}`,
        isSatisfied: (node, world) => {
          // Future stances are planned at their centres. At the actual cell,
          // require the observed body to clear the target: entering the adjacent
          // cell can still leave the player's shoulder inside the doorway.
          const position =
            cellKey(node.feet) === currentCell
              ? observation.position
              : {
                  x: node.feet.x + 0.5,
                  y: node.feet.y,
                  z: node.feet.z + 0.5,
                };
          return resolved.isSatisfied(node, world) && !cellIntersectsPlayerBody(target, position);
        },
      };
    },
  };
  return dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal,
    signal: context.signal,
  });
}

/** Put one carried block on a cell chosen around the bot, without moving. */
async function placeNearby(
  bot: Bot,
  request: PlaceBlockRequest,
  inventoryBefore: number,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
): Promise<PlaceBlockResult> {
  const feet = bot.entity.position.floored();
  const result = await dependencies.placeNearby(bot, request.blockName, { signal: context.signal });
  switch (result.kind) {
    case "placed":
      return {
        status: "succeeded",
        placement: evidence(
          bot,
          request,
          result.position,
          inventoryBefore,
          "air",
          { block: bot.blockAt(result.position.offset(0, -1, 0)) ?? result.block, face: new Vec3(0, 1, 0) },
          true,
          // The block update resolved the placement; the slot that loses the
          // block is broadcast after it.
          await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal }),
        ),
      };
    case "failed":
      return {
        status: "failed",
        error: placeBlockOutcomes.failed(result.error),
        placement: evidence(bot, request, result.position, inventoryBefore, "air"),
      };
    case "no_item":
      return {
        status: "failed",
        error: placeBlockOutcomes.noItem(request.blockName, 0),
        placement: evidence(bot, request, feet, inventoryBefore, null),
      };
    case "no_cell":
      return {
        status: "failed",
        error: placeBlockOutcomesNearby.noFreeCell,
        placement: evidence(bot, request, feet, inventoryBefore, null),
      };
  }
}

/** Place one carried block, at the exact cell asked for or on a cell chosen nearby, and report only what was observed. */
export async function executePlaceBlock(
  bot: Bot,
  request: PlaceBlockRequest,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
): Promise<PlaceBlockResult> {
  const inventoryBefore = carriedCount(bot, request.blockName);
  let progressTarget = request.target;
  context.observeProgress?.(() => ({ baseline: { inventory: inventoryBefore },
    checkpoint: { phase: "placing", inventory: carriedCount(bot, request.blockName), target: progressTarget ? { ...progressTarget } : null,
      currentBlock: progressTarget ? bot.blockAt(new Vec3(progressTarget.x, progressTarget.y, progressTarget.z))?.name ?? null : null },
    completion: { kind: "current", observed: progressTarget !== null && bot.blockAt(new Vec3(progressTarget.x, progressTarget.y, progressTarget.z))?.name === request.blockName,
      owes: "Observed placement of the requested block in the selected cell." },
  }));
  if (!bot.registry.blocksByName[request.blockName]) {
    const feet = bot.entity.position.floored();
    return {
      status: "failed",
      error: placeBlockOutcomes.unknownBlock(request.blockName),
      placement: evidence(bot, request, feet, inventoryBefore, null),
    };
  }
  if (request.target === null) {
    const result = await placeNearby(bot, request, inventoryBefore, context, dependencies);
    progressTarget = result.placement.target;
    return result;
  }

  const target = new Vec3(request.target.x, request.target.y, request.target.z);
  if (inventoryBefore < 1) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noItem(request.blockName, inventoryBefore),
      placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
    };
  }

  let route: NavigationResult | null;
  try {
    route = await approachTarget(bot, target, context, dependencies);
  } catch (cause) {
    context.signal?.throwIfAborted();
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "failed",
      error: placeBlockOutcomes.routeStopped(reason),
      placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
    };
  }
  if (route?.status === "stopped") {
    return {
      status: "failed",
      error: placeBlockOutcomes.routeStopped(route.reason),
      placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
    };
  }
  if (cellIntersectsPlayerBody(target, bot.entity.position)) {
    return {
      status: "failed",
      error: placeBlockOutcomes.failed("The bot's body still intersects the requested cell after approaching it."),
      placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
    };
  }

  const targetBlock = bot.blockAt(target);
  if (!targetBlock) {
    return {
      status: "failed",
      error: placeBlockOutcomes.targetUnloaded,
      placement: evidence(bot, request, target, inventoryBefore, null),
    };
  }
  if (targetBlock.name === request.blockName) {
    return {
      status: "succeeded",
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name),
    };
  }
  if (!isReplaceableForPlacement(targetBlock)) {
    return {
      status: "failed",
      error: placeBlockOutcomes.targetOccupied(targetBlock.name),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name),
    };
  }

  const support = findSupport(bot, target);
  if (!support) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noSupport,
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name),
    };
  }

  const item = bot.inventory.items().find((candidate) => candidate.name === request.blockName);
  if (!item) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noItem(request.blockName, 0),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name, support),
    };
  }

  const result = await dependencies.placeBlock(bot, {
    item,
    support: support.block,
    face: support.face,
    expectedCells: [target],
    matches: (block) => block.name === request.blockName,
    signal: context.signal,
  });
  if (result.kind === "failed") {
    return {
      status: "failed",
      error: placeBlockOutcomes.failed(result.error),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name, support),
    };
  }

  return {
    status: "succeeded",
    placement: evidence(
      bot,
      request,
      target,
      inventoryBefore,
      targetBlock.name,
      support,
      true,
      await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal }),
    ),
  };
}

export function formatPlaceBlockResult(result: PlaceBlockResult): string {
  const { placement } = result;
  const summary = placement.placed
    ? `Placed **${placement.requestedBlock}** at the requested cell.`
    : placement.afterBlock === placement.requestedBlock
      ? `The requested **${placement.requestedBlock}** was already present.`
      : `Did not place **${placement.requestedBlock}**.`;
  const lines = [
    summary,
    `- Target: \`${placement.target.x}, ${placement.target.y}, ${placement.target.z}\` in \`${placement.dimension}\``,
    `- Before: \`${placement.beforeBlock ?? "unloaded"}\``,
    `- After: \`${placement.afterBlock ?? "unloaded"}\``,
    `- Inventory: ${placement.inventoryBefore} → ${placement.inventoryAfter}${unconfirmedCount(placement.confirmed)}`,
  ];
  if (placement.support && placement.face) {
    lines.push(
      `- Support: \`${placement.support.x}, ${placement.support.y}, ${placement.support.z}\`; face \`${placement.face.x}, ${placement.face.y}, ${placement.face.z}\``,
    );
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createPlaceBlockAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: PlaceBlockDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: placeCheckpointSchema,
    name: PLACE_BLOCK,
    description: PLACE_BLOCK_DESCRIPTION,
    inputSchema: placeBlockInputSchema,
    resultSchema: placeBlockResultSchema,
    formatResult: formatPlaceBlockResult,
    execution: { kind: "task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: placeBlockAnnotations,
    parse: parsePlaceBlockRequest,
    execute: (request, context) => executePlaceBlock(bot, request, context, dependencies),
  });
}
