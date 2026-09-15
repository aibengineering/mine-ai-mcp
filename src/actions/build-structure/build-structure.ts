import { buildCheckpointSchema } from "../checkpoint-schemas.js";
/**
 * `build_structure`: ask the build process for a structure, and report
 * the audit of every cell afterwards.
 *
 * Everything physical belongs to the pathfinder. Classifying cells, placing and
 * digging in reach, and routing to the next workable cell are one process
 * there — Baritone's `BuilderProcess` — so this file owns only the MCP
 * contract: what structure was asked for, which blocks a route may not spend
 * as scaffold, and what the run is worth reporting afterwards.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { DIG_REACH } from "../../navigation/movements/excavation.js";
import {
  build,
  type BuildCell,
  type BuildCellState,
  type BuildRequest,
  type BuildResult,
} from "../../navigation/processes/building/build-process.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { asVec3 } from "../../utils/index.js";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../world/block-visibility.js";
import { placeBlock } from "../../world/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import {
  buildStructureAnnotations,
  buildStructureOutcomes,
  NAMED_CELLS_PER_REASON,
  parseBuildStructureRequest,
  BUILD_STRUCTURE,
  BUILD_STRUCTURE_DESCRIPTION,
  buildStructureInputSchema,
  buildStructureResultSchema,
  type LeftReason,
  type BuildStructureRequest,
  type BuildStructureResult,
  type StructureAudit,
  type StructureCell,
} from "./contract.js";

/** The physical side of a build, injectable so the contract can be exercised without a server. */
export type BuildStructurePhysics = Pick<BuildRequest, "movements" | "route" | "breakInPlace" | "canSeeDig" | "place">;

function productionPhysics(
  bot: Bot,
  navigation: NavigationRuntime,
  request: BuildStructureRequest,
): BuildStructurePhysics {
  return {
    // What the structure is made of must not be spent building scaffold to reach it.
    movements: (protectedCells) =>
      createMovements(bot, {
        protectedCells,
        protectedScaffoldNames: [...new Set(request.cells.map((cell) => cell.blockName))].filter(
          (name) => name !== "air",
        ),
      }),
    route: navigation.navigate,
    breakInPlace: navigation.breakBlockInPlace,
    canSeeDig: (target, standing) => {
      const block = bot.blockAt(asVec3(target));
      if (block === null) return false;
      const eye = { x: standing.x, y: standing.y + STANDING_EYE_HEIGHT, z: standing.z };
      return visibleBlockAim(bot.world, eye, target, DIG_REACH, observeMineflayerBlock(block).collisionShapes) !== null;
    },
    place: (placement) => placeBlock(bot, placement),
  };
}

function toBuildCell(cell: StructureCell): BuildCell {
  return { position: { x: cell.x, y: cell.y, z: cell.z }, blockName: cell.blockName };
}

// ── Result settlement ─────────────────────────────────────────────────────────────────────

function leftReason(state: BuildCellState): LeftReason | null {
  switch (state.kind) {
    case "correct":
      return null;
    case "blocked":
    case "diggable":
      return "holds_another_block";
    case "unsupported":
      return "nothing_to_place_against";
    case "not_carried":
      return "block_not_carried";
    case "would_enclose":
      return "would_seal_bot_in";
    case "occupied":
      return "bot_stands_in_it";
    case "unloaded":
      return "not_loaded";
    case "refused":
      return "refused";
    case "placeable":
      // Still workable when the run ended, which the stop reason explains.
      return "not_reached";
  }
}

function shortfall(bot: Bot, result: BuildResult): StructureAudit["missing"] {
  const needed = new Map<string, number>();
  for (const { cell, state } of result.cells) {
    if (state.kind === "correct" || cell.blockName === "air") continue;
    needed.set(cell.blockName, (needed.get(cell.blockName) ?? 0) + 1);
  }
  const carried = new Map<string, number>();
  for (const item of bot.inventory.items()) carried.set(item.name, (carried.get(item.name) ?? 0) + item.count);
  return [...needed]
    .map(([block, count]) => ({ block, count: count - (carried.get(block) ?? 0) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => left.block.localeCompare(right.block));
}

function audit(bot: Bot, result: BuildResult): StructureAudit {
  const left = new Map<LeftReason, StructureAudit["left"][number]>();
  for (const { cell, state } of result.cells) {
    const reason = leftReason(state);
    if (reason === null) continue;
    const group = left.get(reason) ?? { reason, count: 0, named: [] };
    group.count += 1;
    if (group.named.length < NAMED_CELLS_PER_REASON) {
      group.named.push({
        ...cell.position,
        ...("holds" in state && { holds: state.holds }),
        ...(state.kind === "refused" && { detail: state.reason }),
      });
    }
    left.set(reason, group);
  }
  const wrong = result.cells.length - result.cells.filter(({ state }) => state.kind === "correct").length;
  return {
    dimension: bot.game.dimension,
    cells: result.cells.length,
    correct: result.cells.length - wrong,
    placed: result.placed,
    dug: result.dug,
    wrong,
    left: [...left.values()].sort((a, b) => b.count - a.count),
    missing: shortfall(bot, result),
    passes: result.passes,
    complete: wrong === 0,
  };
}

const REASON_WORDS: Record<LeftReason, string> = {
  holds_another_block: "hold another block",
  nothing_to_place_against: "have nothing solid to place against",
  block_not_carried: "need a block the bot does not carry",
  would_seal_bot_in: "would seal the bot in from where it stands",
  bot_stands_in_it: "are where the bot stands",
  not_loaded: "are not loaded",
  refused: "were refused",
  not_reached: "were still to do when the build stopped",
};

function describeLeft(group: StructureAudit["left"][number]): string {
  const named = group.named
    .map((cell) => {
      const at = `${cell.x},${cell.y},${cell.z}`;
      if (cell.holds) return `${cell.holds} at ${at}`;
      if (cell.detail) return `${at}: ${cell.detail}`;
      return at;
    })
    .join("; ");
  const more = group.count > group.named.length ? `, and ${group.count - group.named.length} more` : "";
  return `${group.count} ${REASON_WORDS[group.reason]} (${named}${more})`;
}

// ── Action execution ──────────────────────────────────────────────────────────────────────

export async function buildStructure(
  bot: Bot,
  request: BuildStructureRequest,
  context: ActionContext,
  physics: BuildStructurePhysics,
): Promise<BuildStructureResult> {
  const dimension = bot.game.dimension;
  const correct = () => request.cells.filter((cell) => bot.game.dimension === dimension && bot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name === cell.blockName).length;
  const initial = correct();
  let placed = 0;
  context.observeProgress?.(() => ({ baseline: { correct: initial },
    checkpoint: { phase: "building", correct: correct(), requested: request.cells.length, remaining: request.cells.length - correct(), placed },
    completion: { kind: "current", observed: correct() === request.cells.length, owes: "All requested cells currently contain their specified blocks." },
  }));
  for (const cell of request.cells) {
    if (!bot.registry.blocksByName[cell.blockName]) {
      return {
        status: "failed",
        error: buildStructureOutcomes.unknownBlock(cell.blockName),
        structure: null,
      };
    }
  }
  const toolLoss = request.removeWrongBlocks ? observeToolTierLoss(bot) : null;
  let result: BuildResult;
  try {
    result = await build(bot, {
      ...physics,
      route: (options) => physics.route({ ...options, ...(toolLoss && { onToolSelected: toolLoss.select }) }),
      breakInPlace: (options) => physics.breakInPlace({ ...options, ...(toolLoss && { onToolSelected: toolLoss.select }) }),
      place: async (placement) => {
        const result = await physics.place(placement);
        if (result.kind === "placed") placed++;
        return result;
      },
      cells: request.cells.map(toBuildCell),
      removeWrongBlocks: request.removeWrongBlocks,
      signal: context.signal,
      ...(toolLoss && request.onToolLoss !== "continue" && { stopSignal: toolLoss.signal }),
    });
  } finally { toolLoss?.close(); }
  const structure = audit(bot, result);
  const lost = toolLoss?.loss();
  if (lost && request.onToolLoss !== "continue") return { status: "partial", error: lost.reason, structure };
  if (structure.complete) return { status: "succeeded", structure };
  const error = result.reason
    ? buildStructureOutcomes.stopped(result.reason)
    : buildStructureOutcomes.incomplete(
        structure.wrong,
        structure.left.map(describeLeft).join("; "),
        structure.missing.map((entry) => `${entry.count} ${entry.block}`).join(", "),
      );
  return { status: "failed", error, structure };
}

// ── Action definition ─────────────────────────────────────────────────────────────────────

export function formatBuildStructureResult(result: BuildStructureResult): string {
  const { structure } = result;
  if (structure === null)
    return `**Request rejected:** ${"error" in result ? result.error : "No build was performed."}`;
  const lines = [
    structure.complete
      ? `Every cell of the structure holds its block (${structure.cells} cells).`
      : `The structure is not complete: ${structure.wrong} of ${structure.cells} cells still wrong.`,
    `- Placed ${structure.placed}, dug ${structure.dug}, correct now ${structure.correct}, in \`${structure.dimension}\``,
    ...structure.left.map((group) => `- Left wrong: ${describeLeft(group)}`),
    `- Missing: ${structure.missing.map((entry) => `${entry.count} ${entry.block}`).join(", ") || "nothing"}`,
    `- Passes: ${structure.passes}`,
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createBuildStructureAction(
  bot: Bot,
  navigation: NavigationRuntime,
  physics?: BuildStructurePhysics,
) {
  return defineAction({
    checkpointSchema: buildCheckpointSchema,
    name: BUILD_STRUCTURE,
    description: BUILD_STRUCTURE_DESCRIPTION,
    inputSchema: buildStructureInputSchema,
    resultSchema: buildStructureResultSchema,
    formatResult: formatBuildStructureResult,
    execution: { kind: "task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: buildStructureAnnotations,
    parse: parseBuildStructureRequest,
    execute: (request, context) =>
      buildStructure(bot, request, context, physics ?? productionPhysics(bot, navigation, request)),
  });
}
