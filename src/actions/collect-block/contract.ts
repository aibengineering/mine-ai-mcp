/**
 * MCP schemas, input/output types, constants, and error outcome reporting for collect-block.
 */
import type { Vec3 } from "vec3";
import { z } from "zod";
import type { BlockColour } from "@aibengineering/minecraft-block-highlighter";
import { actionOutputSchema, actionResultSchema, type ActionOutput } from "../action.js";
import { asVec3, type Position3 } from "../../utils/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────────────────

export const COLLECT_BLOCK = "collect_block" as const;
export const COLLECT_BLOCK_DESCRIPTION =
  "Collect matching blocks by searching loaded columns, reaching, digging, and settling one target at a time. " +
  "Without x/y/z it mines the closest matching blocks it can reach, wherever they are, including blocks the bot placed itself; " +
  "reposition with navigate first if you want blocks from a particular area. " +
  "The best carried tool for each block is equipped automatically, so equip is not needed first. " +
  "By default a required tool-tier loss stops with partial progress; on_tool_loss=continue keeps mining with the remaining tool. " +
  "The response lists every cell broken and its distance from where the run started. " +
  "Water beside or above a target is harmless; lava is closed with a carried block before the break, so collecting obsidian means carrying cobblestone, and a target that cannot be taken says why in numbers. " +
  "Obsidian is the one block the bot makes rather than finds: ask for it while carrying a water bucket and, with no obsidian loaded, the process walks to lava, pours, scoops the water back, and mines what formed. " +
  "Name the block to break, not the item wanted: cobblestone and cobbled_deepslate are the no-silk-touch drops of stone and deepslate, which are almost everywhere underground, while naturally placed cobblestone is structure-bound and most often the walls of a dungeon around a spawner. " +
  "For general collection tasks, prefer count greater than 1 without an exact x/y/z target; use exact coordinates only when that specific block matters.";
export const MAX_COLLECT_BLOCKS = 32;
export const NON_MINEABLE_FLUIDS = new Set(["water", "lava", "bubble_column"]);
/**
 * How many blocks past the request may be broken before the run gives up.
 *
 * Drops are no longer predicted, so losing one to lava, a fluid, or a fall is
 * an ordinary outcome rather than a defect — the run simply mines another. The
 * allowance covers a hazardous seam without licensing an unbounded dig.
 */
export const MAX_EXTRA_BREAKS = 4;

/**
 * How long a step's highlight stays up. Each publish replaces the last, so this
 * is really "until the next step, or this long if the step is the final one".
 * It costs no run time — nothing waits on it — so it is set for a person
 * watching rather than for the bot.
 */
export const HIGHLIGHT_HOLD_MS = 5_000;

export const HIGHLIGHT_COLOURS = {
  candidate: "#ffaa0d",
  accepted: "#33ff61",
  rejected: "#ff2914",
  approach: "#1f8cff",
  dig: "#ff381a",
  drop: "#38ff59",
} as const satisfies Record<string, BlockColour>;

// ── Reported outcomes ─────────────────────────────────────────────────────────────────────

export function cellLabel(position: Position3): string {
  return `${position.x},${position.y},${position.z}`;
}

export function decimal(value: number): number {
  return Number(value.toFixed(1));
}

/** The items a capacity refusal was about: named when few, counted when the selector matched many. */
function describeItems(itemNames: readonly string[]): string {
  const names = [...new Set(itemNames)].sort();
  if (names.length > 3) return `any of the ${names.length} matching items`;
  return names.join(" or ") || "a matching item";
}

export const outcomes = {
  coordinatesTogether: "x, y, and z must be provided together.",
  notMineable: (blockName: string) => `${blockName} is not a mineable block.`,
  invalidTarget: "block_name must identify a block after the optional minecraft: prefix.",
  targetMismatch: (position: Position3, observedName: string, selector: string) =>
    `[COLLECT_TARGET_MISMATCH] The requested cell at ${cellLabel(position)} is ${observedName}, not ${selector}.`,
  targetsUnreachable: (selector: string, reason: string) =>
    `[NO_REACHABLE_MATCHING_TARGETS] Every loaded ${selector} block was found but none could be reached. Last routing stop: ${reason}`,
  noLoadedTargets: (selector: string) => `[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded ${selector} blocks.`,
  unmineable: (blockName: string, position: Position3, reason: string) =>
    `[TARGET_UNMINEABLE] ${blockName} at ${cellLabel(position)} cannot be broken: ${reason}.`,
  dropAttemptsExhausted: (mined: number, collected: number, requested: number) =>
    `[DROP_RECOVERY_EXHAUSTED] Mined ${mined} blocks and collected ${collected} of the ${requested} requested; the rest were mined but never recovered, so collection stopped instead of mining indefinitely.`,
  inventoryFull: (totalSlots: number, itemNames: readonly string[]) =>
    `[INVENTORY_FULL] All ${totalSlots} inventory slots are occupied with no room in a stack of ${describeItems(itemNames)}; allow_full_inventory=false.`,
  incomplete: "[COLLECTION_INCOMPLETE] Collection stopped before the requested inventory gain was observed.",
  progress: (reason: string, gained: number, requested: number, blocksBroken: number) =>
    `${reason} Broke ${blocksBroken} matching block${blocksBroken === 1 ? "" : "s"}; inventory gained ${gained}/${requested} requested items.`,
} as const;

// ── Action contract & schemas ─────────────────────────────────────────────────────────────

const collectBlockSelectorSchema = z
  .string()
  .trim()
  .min(1)
  .transform((blockName, context) => {
    const selector = blockName.toLowerCase().replace(/^minecraft:/, "");
    if (!selector) {
      context.addIssue({ code: "custom", message: outcomes.invalidTarget });
      return z.NEVER;
    }
    if (NON_MINEABLE_FLUIDS.has(selector)) {
      context.addIssue({ code: "custom", message: outcomes.notMineable(blockName) });
      return z.NEVER;
    }
    return selector;
  })
  .describe("Exact Minecraft block name, or logs for any log block.");

/** External MCP arguments. */
export const collectBlockInputSchema = z
  .strictObject({
    block_name: collectBlockSelectorSchema,
    count: z.number().int().min(1).max(MAX_COLLECT_BLOCKS).default(1).describe("Number of item drops to collect."),
    x: z.number().int().optional().describe("Exact target block x; provide x, y, and z together."),
    y: z.number().int().optional().describe("Exact target block y; provide x, y, and z together."),
    z: z.number().int().optional().describe("Exact target block z; provide x, y, and z together."),
    scaffold: z
      .boolean()
      .default(true)
      .describe("Allow carried dirt, cobblestone, netherrack, or basalt to reach the target."),
    allow_full_inventory: z
      .boolean()
      .default(false)
      .describe(
        "Allow breaking even when no inventory space for the requested drops is observed; drops may remain in the world.",
      ),
    on_tool_loss: z.enum(["stop", "continue"]).default("stop")
      .describe("Stop with partial progress when the best required tool tier drops, or continue the same collection with the remaining tool."),
  })
  .superRefine((value, context) => {
    const coordinates = [value.x, value.y, value.z].filter((coordinate) => coordinate !== undefined).length;
    if (coordinates !== 0 && coordinates !== 3) {
      context.addIssue({ code: "custom", message: outcomes.coordinatesTogether });
    }
  });

export interface CollectBlockRequest {
  selector: string;
  requested: number;
  exactTarget: Vec3 | null;
  scaffolding: boolean;
  allowFullInventory: boolean;
  onToolLoss: "stop" | "continue";
}

export function parseCollectBlockRequest(input: unknown): CollectBlockRequest {
  const value = collectBlockInputSchema.parse(input ?? {});
  const exactTarget =
    value.x === undefined || value.y === undefined || value.z === undefined
      ? null
      : asVec3({ x: value.x, y: value.y, z: value.z });
  return {
    selector: value.block_name,
    requested: exactTarget ? 1 : value.count,
    exactTarget,
    scaffolding: value.scaffold,
    allowFullInventory: value.allow_full_inventory,
    onToolLoss: value.on_tool_loss,
  };
}

/** A matching cell the run broke, and how far it was from where the run started. */
const brokenCellSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  distanceFromStart: z.number().nonnegative(),
});

const collectionEvidenceSchema = z.strictObject({
  requested: z.number().int().nonnegative(),
  gained: z.number().int().nonnegative(),
  gainedByItem: z.record(z.string(), z.number().int().nonnegative()),
  blocksBroken: z.number().int().nonnegative(),
  brokenAt: z.array(brokenCellSchema),
});

export type BrokenCell = z.output<typeof brokenCellSchema>;

/** Complete physical result produced by the collection executor. */
export const collectBlockResultSchema = actionResultSchema({
  collected: collectionEvidenceSchema,
});

/**
 * Layer 2 (Action Aggregate Result): The complete domain result of the whole action request.
 * Contains high-level outcome status ('succeeded' | 'partial' | 'failed'), exact item gains,
 * blocks broken, and deterministic failure reasons.
 */
export type CollectBlockResult = z.output<typeof collectBlockResultSchema>;

/** Stable runtime-output schema available without constructing a bot-bound action. */
export const collectBlockOutputSchema = actionOutputSchema(
  COLLECT_BLOCK,
  collectBlockResultSchema,
);

/**
 * Layer 2 Typed Action Output: Associates the action name tag with its typed result.
 */
export type CollectBlockOutput = ActionOutput<typeof COLLECT_BLOCK, CollectBlockResult>;
