import { z } from "zod";
import type { ControlState } from "mineflayer";
import { actionResultSchema } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const RAW_ACTION = "raw_action" as const;
export const RAW_ACTION_DESCRIPTION =
  "One short, foreground Mineflayer body attempt for an emergency wedge where ordinary actions refuse. It deliberately bypasses route planning and action-specific footing/terrain policy, but retains foreground ownership, cancellation, server reach, and a hard no-dig-in-lava boundary. It never resumes: look once, dig one reachable block, place one carried block against a reachable face, swing once, use the held item once, or hold one control for at most 40 physics ticks. Reports the attempted call separately from observed world, inventory, heading, and position effects.";

const coordinate = z.number().int().safe();
const controlStateSchema = z.enum([
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
]);
const faceSchema = z.enum(["up", "down", "north", "south", "east", "west"]);

/**
 * The fields each operation reads. The MCP input stays one flat object (see
 * raw-action.test.ts), so this table is what keeps it honest: `oneOf` lists
 * alternative field sets of which exactly one must be complete, `optional`
 * fields may be omitted, and every other operation field is refused, so a
 * model that mixes fields learns which operation ignored them rather than
 * watching them do nothing. `blockCell` operations name a whole block.
 */
type OperationFields =
  | { readonly oneOf: readonly (readonly string[])[]; readonly missing: string; readonly blockCell?: true; readonly optional?: never }
  | { readonly optional: readonly string[]; readonly oneOf?: never; readonly blockCell?: never };
const OPERATION_FIELDS = {
  look: { oneOf: [["yaw", "pitch"], ["x", "y", "z"]], missing: "look requires either yaw and pitch, or x, y, and z." },
  dig: { oneOf: [["x", "y", "z"]], missing: "dig requires x, y, and z.", blockCell: true },
  place: {
    oneOf: [["block_name", "x", "y", "z", "face"]],
    missing: "place requires block_name, x, y, z, and face.",
    blockCell: true,
  },
  swing: { optional: ["entity_id"] },
  use_item: { optional: ["hand"] },
  control: { oneOf: [["state", "ticks"]], missing: "control requires state and ticks." },
} as const satisfies Record<string, OperationFields>;

export const rawActionInputSchema = z
  .strictObject({
    operation: z.enum(["look", "dig", "place", "swing", "use_item", "control"]),
    x: z.number().safe().optional(),
    y: z.number().safe().optional(),
    z: z.number().safe().optional(),
    yaw: z.number().finite().optional(),
    pitch: z
      .number()
      .finite()
      .min(-Math.PI / 2)
      .max(Math.PI / 2)
      .optional(),
    block_name: registryNameSchema.optional(),
    face: faceSchema.optional(),
    entity_id: coordinate.optional(),
    hand: z.enum(["hand", "off-hand"]).optional(),
    state: controlStateSchema.optional(),
    ticks: z.number().int().min(1).max(40).optional(),
  })
  .superRefine((value, context) => {
    const rule: OperationFields = OPERATION_FIELDS[value.operation];
    const issue = (message: string, path: string[] = []) => context.addIssue({ code: "custom", path, message });
    const forbidAllBut = (used: readonly string[]) => {
      for (const key of Object.keys(value))
        if (rawActionInputKeys.has(key) && key !== "operation" && !used.includes(key))
          issue(`${key} is not used by ${value.operation}.`, [key]);
    };
    if (!rule.oneOf) return forbidAllBut(rule.optional);
    const complete = rule.oneOf.map((fields) => fields.every((name) => Reflect.get(value, name) !== undefined));
    if (complete.filter(Boolean).length !== 1) {
      issue(rule.missing);
      // An operation with one required set has nothing more to judge until it is complete.
      if (rule.oneOf.length === 1) return;
    }
    forbidAllBut(rule.oneOf[complete.indexOf(true)] ?? rule.oneOf.at(-1)!);
    if (rule.blockCell)
      for (const key of ["x", "y", "z"] as const)
        if (!Number.isInteger(value[key])) issue(`${key} must be an integer block coordinate.`, [key]);
  });
const rawActionInputKeys = new Set(Object.keys(rawActionInputSchema.shape));

export type RawActionRequest =
  | {
      operation: "look";
      target: { x: number; y: number; z: number } | null;
      yaw: number | null;
      pitch: number | null;
    }
  | { operation: "dig"; target: { x: number; y: number; z: number } }
  | {
      operation: "place";
      blockName: string;
      support: { x: number; y: number; z: number };
      face: z.output<typeof faceSchema>;
    }
  | { operation: "swing"; entityId: number | null }
  | { operation: "use_item"; hand: "hand" | "off-hand" }
  | { operation: "control"; state: ControlState; ticks: number };

export function parseRawActionRequest(input: unknown): RawActionRequest {
  const v = rawActionInputSchema.parse(input);
  switch (v.operation) {
    case "look":
      return {
        operation: "look",
        target: v.x === undefined ? null : { x: v.x, y: v.y!, z: v.z! },
        yaw: v.yaw ?? null,
        pitch: v.pitch ?? null,
      };
    case "dig":
      return { operation: "dig", target: { x: v.x!, y: v.y!, z: v.z! } };
    case "place":
      return {
        operation: "place",
        blockName: v.block_name!,
        support: { x: v.x!, y: v.y!, z: v.z! },
        face: v.face!,
      };
    case "swing":
      return { operation: "swing", entityId: v.entity_id ?? null };
    case "use_item":
      return { operation: "use_item", hand: v.hand ?? "hand" };
    case "control":
      return { operation: "control", state: v.state!, ticks: v.ticks! };
  }
}

const vectorSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
const observationSchema = z.strictObject({
  position: vectorSchema,
  yaw: z.number(),
  pitch: z.number(),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
});
export const rawActionResultSchema = actionResultSchema({
  operation: z.enum(["look", "dig", "place", "swing", "use_item", "control"]),
  before: observationSchema,
  after: observationSchema,
  target: vectorSchema.nullable(),
  beforeBlock: z.string().nullable(),
  afterBlock: z.string().nullable(),
  entityId: z.number().int().nullable(),
  entityPresentAfter: z.boolean().nullable(),
  attempted: z.boolean(),
  effectObserved: z.boolean().nullable(),
});
export type RawActionResult = z.output<typeof rawActionResultSchema>;
