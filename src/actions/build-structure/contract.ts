import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const BUILD_STRUCTURE = "build_structure" as const;
export const BUILD_STRUCTURE_DESCRIPTION =
  "Build a structure given as cells, each an absolute x, y, z and a carried block name, or air for a cell to dig clear, or as a nether portal frame using 10 obsidian and 4 corner support blocks (cobblestone by default) at an interior corner with its interior kept clear. Places every cell it can reach from where the bot stands, walks within reach of the rest lowest first, never builds itself in, and reports what was placed, dug, and short, and why each cell still wrong was left: holding another block, nothing to place against, its block not carried, would seal the bot in, or refused. Required tool-tier loss stops with partial progress by default; on_tool_loss=continue keeps the same build running. Sending the same structure again resumes or audits it.";

/** How many cells one build may describe; a portal preset is twenty and a small shelter under a hundred. */
export const MAX_STRUCTURE_CELLS = 256;

const coordinate = (axis: string) => z.number().int().safe().describe(`Absolute ${axis} coordinate.`);

export const structureCellSchema = z.strictObject({
  x: coordinate("X"),
  y: coordinate("Y"),
  z: coordinate("Z"),
  block_name: registryNameSchema.describe(
    "Block registry name carried as an item, such as cobblestone; air asks for the cell to be dug clear.",
  ),
});

export const portalFrameRequestSchema = z.strictObject({
  x: coordinate("X").describe("X of the interior's lowest corner."),
  y: coordinate("Y").describe("Y of the interior's lowest row, one above the ground the frame stands on."),
  z: coordinate("Z").describe("Z of the interior's lowest corner."),
  axis: z.enum(["x", "z"]).default("x").describe("The horizontal axis the frame's width runs along."),
  corner_block: registryNameSchema
    .default("cobblestone")
    .describe(
      "Carried solid block for the four corner supports, such as cobblestone or dirt. Supports remain in place.",
    ),
});

export const buildStructureInputSchema = z.strictObject({
  blocks: z
    .array(structureCellSchema)
    .max(MAX_STRUCTURE_CELLS)
    .optional()
    .describe("The structure's cells. Cells already holding the block are counted correct and left alone."),
  portal_frame: portalFrameRequestSchema
    .optional()
    .describe(
      "A nether portal frame using 10 obsidian and 4 corner support blocks (cobblestone by default), with its six interior cells kept clear, expanded to cells before building.",
    ),
  remove_wrong_blocks: z
    .boolean()
    .default(false)
    .describe("Dig a cell holding the wrong block before placing. Off, such cells are reported as wrong."),
  on_tool_loss: z.enum(["stop", "continue"]).default("stop")
    .describe("Stop with a partial structure when the best required digging tool tier drops, or continue with the remaining tool."),
});

export interface StructureCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly blockName: string;
}

export interface BuildStructureRequest {
  readonly cells: readonly StructureCell[];
  readonly removeWrongBlocks: boolean;
  readonly onToolLoss?: "stop" | "continue";
}

/**
 * Ten obsidian form the portal edges. Four ordinary corner blocks provide
 * placement support, including for the top row, and can remain after lighting.
 * The six interior cells must be air: a live run left cobblestone scaffold
 * through the opening and produced a frame that could not be lit.
 */
export function portalFrameCells(frame: z.output<typeof portalFrameRequestSchema>): StructureCell[] {
  const cells: StructureCell[] = [];
  const along = (offset: number, y: number, blockName = "obsidian"): StructureCell =>
    frame.axis === "x"
      ? { x: frame.x + offset, y, z: frame.z, blockName }
      : { x: frame.x, y, z: frame.z + offset, blockName };
  const rowBlock = (offset: number) => (offset === -1 || offset === 2 ? frame.corner_block : "obsidian");
  for (let offset = -1; offset <= 2; offset += 1) cells.push(along(offset, frame.y - 1, rowBlock(offset)));
  for (let up = 0; up < 3; up += 1) {
    cells.push(along(-1, frame.y + up));
    cells.push(along(0, frame.y + up, "air"));
    cells.push(along(1, frame.y + up, "air"));
    cells.push(along(2, frame.y + up));
  }
  for (let offset = -1; offset <= 2; offset += 1) cells.push(along(offset, frame.y + 3, rowBlock(offset)));
  return cells;
}

export function parseBuildStructureRequest(input: unknown): BuildStructureRequest {
  const value = buildStructureInputSchema.parse(input ?? {});
  const cells: StructureCell[] = [
    ...(value.blocks ?? []).map((cell) => ({ x: cell.x, y: cell.y, z: cell.z, blockName: cell.block_name })),
    ...(value.portal_frame ? portalFrameCells(value.portal_frame) : []),
  ];
  if (cells.length === 0) throw new Error("A structure needs blocks or a portal_frame.");
  if (cells.length > MAX_STRUCTURE_CELLS) {
    throw new Error(`A structure may describe at most ${MAX_STRUCTURE_CELLS} cells; this one has ${cells.length}.`);
  }
  const byCell = new Map<string, StructureCell>();
  for (const cell of cells) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    const existing = byCell.get(key);
    if (existing && existing.blockName !== cell.blockName) {
      throw new Error(`Cell ${key} is asked to be both ${existing.blockName} and ${cell.blockName}.`);
    }
    byCell.set(key, cell);
  }
  return { cells: [...byCell.values()], removeWrongBlocks: value.remove_wrong_blocks, onToolLoss: value.on_tool_loss };
}

/** Why a wrong cell was left, in the words of what was observed there. */
export const LEFT_REASONS = [
  "holds_another_block",
  "nothing_to_place_against",
  "block_not_carried",
  "would_seal_bot_in",
  "bot_stands_in_it",
  "not_loaded",
  "refused",
  "not_reached",
] as const;
export type LeftReason = (typeof LEFT_REASONS)[number];

/**
 * How many cells are named per reason. A structure may be 256 cells, and a
 * response that lists every one of them buries the count that matters; a few
 * positions are enough to send the next request at the right cells.
 */
export const NAMED_CELLS_PER_REASON = 4;

export const leftCellSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  /** The block observed in the cell, when the reason is about it. */
  holds: z.string().optional(),
  /** What refused the cell, when something did. */
  detail: z.string().optional(),
});

export const structureAuditSchema = z.strictObject({
  dimension: z.string(),
  cells: z.number().int().nonnegative(),
  /** Cells matching the structure when the action finished. */
  correct: z.number().int().nonnegative(),
  placed: z.number().int().nonnegative(),
  dug: z.number().int().nonnegative(),
  /** Cells still holding something other than the requested block. */
  wrong: z.number().int().nonnegative(),
  /** The wrong cells grouped by why they were left, with up to a few of each named. */
  left: z.array(
    z.strictObject({
      reason: z.enum(LEFT_REASONS),
      count: z.number().int().positive(),
      named: z.array(leftCellSchema).max(NAMED_CELLS_PER_REASON),
    }),
  ),
  missing: z.array(z.strictObject({ block: z.string(), count: z.number().int().positive() })),
  passes: z.number().int().nonnegative(),
  complete: z.boolean(),
});

export const buildStructureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), structure: structureAuditSchema }),
  z.strictObject({ status: z.literal("partial"), error: z.string(), structure: structureAuditSchema.nullable() }),
  z.strictObject({ status: z.literal("failed"), error: z.string(), structure: structureAuditSchema.nullable() }),
]);

export type StructureAudit = z.output<typeof structureAuditSchema>;
export type BuildStructureResult = z.output<typeof buildStructureResultSchema>;
export type BuildStructureOutput = ActionOutput<typeof BUILD_STRUCTURE, BuildStructureResult>;

export const buildStructureAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const buildStructureOutcomes = {
  unknownBlock: (blockName: string) => `[BUILD_UNKNOWN_BLOCK] Minecraft has no block named ${blockName}.`,
  incomplete: (wrong: number, left: string, missing: string) =>
    `[BUILD_INCOMPLETE] ${wrong} cell${wrong === 1 ? "" : "s"} still wrong: ${left}` +
    (missing ? `; short of ${missing}` : "") +
    ".",
  stopped: (reason: string) => `[BUILD_STOPPED] The build stopped: ${reason}.`,
} as const;
