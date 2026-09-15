import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const ACTIVATE_PORTAL = "activate_portal" as const;
export const ACTIVATE_PORTAL_DESCRIPTION =
  "Activate an existing Nether or End portal. Name an obsidian frame block (or Nether interior cell), or an end_portal_frame block. Validates the complete frame, uses carried flint_and_steel or fills missing End sockets with ender_eye, and confirms every interior portal block. Skips filled sockets and already active portals, so repeating after cancellation resumes from the world. Does not enter the portal.";

const coordinate = (axis: string) =>
  z.number().int().safe().describe(`Absolute ${axis} coordinate of a portal frame block, or a Nether interior cell.`);
export const activatePortalInputSchema = z.strictObject({
  x: coordinate("X"),
  y: coordinate("Y"),
  z: coordinate("Z"),
});
export type ActivatePortalRequest = z.output<typeof activatePortalInputSchema>;
export function parseActivatePortalRequest(input: unknown): ActivatePortalRequest {
  return activatePortalInputSchema.parse(input ?? {});
}

const position = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
export const netherPortalFrameSchema = z.strictObject({
  axis: z.enum(["x", "z"]),
  origin: position,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type NetherPortalFrame = z.output<typeof netherPortalFrameSchema>;

const portalCounts = {
  portalBefore: z.number().int().nonnegative(),
  portalAfter: z.number().int().nonnegative(),
  activated: z.boolean(),
};
export const portalActivationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unresolved") }),
  z.strictObject({ kind: z.literal("nether"), frame: netherPortalFrameSchema, ...portalCounts }),
  z.strictObject({
    kind: z.literal("end"),
    center: position,
    eyesBefore: z.number().int().min(0).max(12),
    eyesAfter: z.number().int().min(0).max(12),
    ...portalCounts,
  }),
]);
export const activatePortalResultSchema = actionResultSchema({
  dimension: z.string(),
  target: position,
  portal: portalActivationEvidenceSchema,
});
export type PortalActivationEvidence = z.output<typeof portalActivationEvidenceSchema>;
export type ActivatePortalResult = z.output<typeof activatePortalResultSchema>;
export type ActivatePortalOutput = ActionOutput<typeof ACTIVATE_PORTAL, ActivatePortalResult>;

export const activatePortalAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;
