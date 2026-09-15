import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ControlState } from "mineflayer";
import { actionResultSchema, type ActionOutput } from "../action.js";
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
    const exactly = (names: readonly string[]) =>
      names.every((name) => Reflect.get(value, name) !== undefined);
    const forbid = (allowed: readonly string[]) => {
      for (const key of Object.keys(value))
        if (
          rawActionInputKeys.has(key) &&
          key !== "operation" &&
          !allowed.includes(key)
        )
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is not used by ${value.operation}.`,
          });
    };
    switch (value.operation) {
      case "look": {
        const angles = exactly(["yaw", "pitch"]),
          target = exactly(["x", "y", "z"]);
        if (angles === target)
          context.addIssue({
            code: "custom",
            message: "look requires either yaw and pitch, or x, y, and z.",
          });
        forbid(angles ? ["yaw", "pitch"] : ["x", "y", "z"]);
        break;
      }
      case "dig":
        if (!exactly(["x", "y", "z"]))
          context.addIssue({
            code: "custom",
            message: "dig requires x, y, and z.",
          });
        else {
          forbid(["x", "y", "z"]);
          for (const key of ["x", "y", "z"] as const)
            if (!Number.isInteger(value[key]))
              context.addIssue({
                code: "custom",
                path: [key],
                message: `${key} must be an integer block coordinate.`,
              });
        }
        break;
      case "place":
        if (!exactly(["block_name", "x", "y", "z", "face"]))
          context.addIssue({
            code: "custom",
            message: "place requires block_name, x, y, z, and face.",
          });
        else {
          forbid(["block_name", "x", "y", "z", "face"]);
          for (const key of ["x", "y", "z"] as const)
            if (!Number.isInteger(value[key]))
              context.addIssue({
                code: "custom",
                path: [key],
                message: `${key} must be an integer block coordinate.`,
              });
        }
        break;
      case "swing":
        forbid(["entity_id"]);
        break;
      case "use_item":
        forbid(["hand"]);
        break;
      case "control":
        if (!exactly(["state", "ticks"]))
          context.addIssue({
            code: "custom",
            message: "control requires state and ticks.",
          });
        else forbid(["state", "ticks"]);
        break;
    }
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
export type RawActionOutput = ActionOutput<typeof RAW_ACTION, RawActionResult>;
export const rawActionAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;
