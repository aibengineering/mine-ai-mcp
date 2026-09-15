/**
 * `view_blocks`: the blocks around the bot, read without moving.
 *
 * Three quarters of the debug JavaScript the bots ran after `view_status`
 * landed was one of two shapes: find the nearest blocks by name, or read the
 * cells in a small box or a short list. This is those two shapes as one typed
 * read. The find is the mine process's loaded-column scan with no radius, so
 * finding and mining agree about what is loaded; the box is drawn as one grid
 * per layer with a legend, because a picture of nine by nine cells reads in
 * a glance where a list of eighty-one does not.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findLoadedBlockPositions, isLiquid } from "../../world/index.js";
import { defineAction } from "../action.js";
import { blockMatchesSelector } from "../collect-block/collection-facts.js";
import {
  parseViewBlocksRequest,
  VIEW_BLOCKS,
  VIEW_BLOCKS_DESCRIPTION,
  viewBlocksInputSchema,
  viewBlocksResultSchema,
  viewBlocksAnnotations,
  viewBlocksOutcomes,
  type FoundBlock,
  type ObservedBlock,
  type ViewBlocksRequest,
  type ViewBlocksResult,
  type ViewBlocksReport,
} from "./contract.js";

function observe(bot: Bot, position: Vec3): ObservedBlock {
  const block = bot.blockAt(position);
  const base = { x: position.x, y: position.y, z: position.z };
  if (!block) return { ...base, name: "unloaded", shape: "open" };
  const properties = (block.getProperties?.() ?? {}) as Record<string, unknown>;
  const observed: ObservedBlock = {
    ...base,
    name: block.name,
    shape: isLiquid(block) ? "liquid" : block.boundingBox === "block" ? "solid" : "open",
  };
  // prismarine-block reports state values as strings; a liquid's level is one.
  const level = Number(properties.level);
  if (isLiquid(block) && properties.level !== undefined && Number.isInteger(level)) observed.level = level;
  if (properties.waterlogged === true || properties.waterlogged === "true") observed.waterlogged = true;
  return observed;
}

function nameAt(bot: Bot, position: Vec3): string {
  return bot.blockAt(position)?.name ?? "unloaded";
}

/** Every registry state a requested name selects; none means Minecraft has no such block. */
function selectedStateIds(bot: Bot, name: string): Set<number> {
  const stateIds = new Set<number>();
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (!blockMatchesSelector(block.name, name)) continue;
    for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) stateIds.add(stateId);
  }
  return stateIds;
}

function find(
  bot: Bot,
  feet: Vec3,
  request: NonNullable<ViewBlocksRequest["find"]>,
): { found: NonNullable<ViewBlocksReport["find"]> } | { unknown: string } {
  const found: NonNullable<ViewBlocksReport["find"]> = [];
  for (const name of request.blockNames) {
    const stateIds = selectedStateIds(bot, name);
    if (stateIds.size === 0) return { unknown: name };
    // The scan is nearest first and cheap: it reads packed state IDs, so the
    // count of everything loaded costs no more than the few that are listed.
    const positions = findLoadedBlockPositions(bot, { center: feet, stateIds, limit: Number.POSITIVE_INFINITY });
    const listed: FoundBlock[] = positions.slice(0, request.limit).map((position) => ({
      ...observe(bot, position),
      distance: Math.round(position.distanceTo(feet) * 10) / 10,
      above: nameAt(bot, position.offset(0, 1, 0)),
      below: nameAt(bot, position.offset(0, -1, 0)),
    }));
    found.push({ name, found: positions.length, listed });
  }
  return { found };
}

function box(bot: Bot, request: NonNullable<ViewBlocksRequest["box"]>): NonNullable<ViewBlocksReport["box"]> {
  const layers: NonNullable<ViewBlocksReport["box"]>["layers"] = [];
  for (let y = request.y + request.halfHeight; y >= request.y - request.halfHeight; y -= 1) {
    const rows: { z: number; blocks: string[] }[] = [];
    for (let z = request.z - request.halfWidth; z <= request.z + request.halfWidth; z += 1) {
      const blocks: string[] = [];
      for (let x = request.x - request.halfWidth; x <= request.x + request.halfWidth; x += 1) {
        blocks.push(nameAt(bot, new Vec3(x, y, z)));
      }
      rows.push({ z, blocks });
    }
    layers.push({ y, rows });
  }
  return {
    center: { x: request.x, y: request.y, z: request.z },
    halfWidth: request.halfWidth,
    halfHeight: request.halfHeight,
    layers,
  };
}

export function viewBlocks(bot: Bot, request: ViewBlocksRequest): ViewBlocksResult {
  const feet = bot.entity.position.floored();
  const report: ViewBlocksReport = {
    dimension: bot.game.dimension,
    feet: { x: feet.x, y: feet.y, z: feet.z },
    loadedChunks: bot.world.getColumns().length,
    find: null,
    box: request.box ? box(bot, request.box) : null,
    cells: request.cells.map((cell) => observe(bot, new Vec3(cell.x, cell.y, cell.z))),
  };
  if (request.find) {
    const result = find(bot, feet, request.find);
    if ("unknown" in result) {
      return { status: "failed", error: viewBlocksOutcomes.unknownBlock(result.unknown), blocks: report };
    }
    return { status: "succeeded", blocks: { ...report, find: result.found } };
  }
  return { status: "succeeded", blocks: report };
}

// ── Markdown ──────────────────────────────────────────────────────────────────────────────

const FIXED_SYMBOLS: Record<string, string> = {
  air: ".",
  cave_air: ".",
  void_air: ".",
  water: "~",
  lava: "#",
  unloaded: "?",
};

function shapeWords(block: ObservedBlock): string {
  const words = [
    block.shape === "liquid" ? (block.level === 0 ? "source" : `flowing level ${block.level ?? "?"}`) : block.shape,
  ];
  if (block.waterlogged) words.push("waterlogged");
  return words.join(", ");
}

/** One grid per layer, x across and z down, with a legend of one symbol per block name. */
function drawBox(report: NonNullable<ViewBlocksReport["box"]>): string[] {
  const counts = new Map<string, number>();
  for (const layer of report.layers)
    for (const row of layer.rows) for (const name of row.blocks) counts.set(name, (counts.get(name) ?? 0) + 1);
  const symbols = new Map<string, string>();
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let next = 0;
  for (const [name] of [...counts].sort((left, right) => right[1] - left[1])) {
    symbols.set(name, FIXED_SYMBOLS[name] ?? letters[next++] ?? "*");
  }
  const { center, halfWidth } = report;
  const lines = [
    `### Box around ${center.x}, ${center.y}, ${center.z} (x ${center.x - halfWidth}..${center.x + halfWidth} across, z ${center.z - halfWidth}..${center.z + halfWidth} down)`,
  ];
  for (const layer of report.layers) {
    lines.push("", `y=${layer.y}`, "```");
    for (const row of layer.rows) {
      lines.push(`${String(row.z).padStart(5)}  ${row.blocks.map((name) => symbols.get(name) ?? "*").join(" ")}`);
    }
    lines.push("```");
  }
  lines.push(
    "",
    `Legend: ${[...symbols].map(([name, symbol]) => `${symbol} ${name} (${counts.get(name)})`).join(", ")}`,
  );
  return lines;
}

export function formatViewBlocksResult(result: ViewBlocksResult): string {
  const { blocks } = result;
  const lines = [
    `Bot feet at ${blocks.feet.x}, ${blocks.feet.y}, ${blocks.feet.z} in \`${blocks.dimension}\`; ${blocks.loadedChunks} chunks loaded.`,
  ];
  for (const entry of blocks.find ?? []) {
    const heading = `### ${entry.name}: ${entry.found} loaded`;
    lines.push("", entry.found > entry.listed.length ? `${heading}, nearest ${entry.listed.length} listed` : heading);
    for (const hit of entry.listed) {
      lines.push(
        `- ${hit.name} at ${hit.x}, ${hit.y}, ${hit.z}, ${hit.distance} blocks away (${shapeWords(hit)}); above ${hit.above}, below ${hit.below}`,
      );
    }
    if (entry.listed.length === 0) lines.push("- none loaded");
  }
  if (blocks.box) lines.push("", ...drawBox(blocks.box));
  if (blocks.cells.length > 0) {
    lines.push("", "### Cells");
    for (const cell of blocks.cells)
      lines.push(`- ${cell.x}, ${cell.y}, ${cell.z}: ${cell.name} (${shapeWords(cell)})`);
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createViewBlocksAction(bot: Bot) {
  return defineAction({
    name: VIEW_BLOCKS,
    description: VIEW_BLOCKS_DESCRIPTION,
    inputSchema: viewBlocksInputSchema,
    resultSchema: viewBlocksResultSchema,
    formatResult: formatViewBlocksResult,
    execution: { kind: "information" },
    annotations: viewBlocksAnnotations,
    parse: parseViewBlocksRequest,
    execute: async (request) => viewBlocks(bot, request),
  });
}
