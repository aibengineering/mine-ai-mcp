import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { navigationEvidenceSchema } from "../navigate/contract.js";

export const ENTER_NETHER_PORTAL = "enter_nether_portal" as const;
export const ENTER_END_PORTAL = "enter_end_portal" as const;
export const ENTER_NETHER_PORTAL_DESCRIPTION =
  "Enter the active Nether portal block at x,y,z and wait for server-positioned arrival. From the Overworld this enters the Nether; from the Nether it returns to the Overworld. Entry checks food and arrows unless allow_low_supplies is true; return is exempt.";
export const ENTER_END_PORTAL_DESCRIPTION =
  "Enter the active End portal block at x,y,z and wait for server-positioned arrival. Entering the End requires a personal respawn bed observed through this session's sleep action within respawn_within blocks (default 128), unless allow_distant_respawn is true. Returning from the End is exempt.";

const coordinates = {
  x: z.number().int().describe("Absolute X coordinate of an active portal block."),
  y: z.number().int().describe("Absolute Y coordinate of an active portal block."),
  z: z.number().int().describe("Absolute Z coordinate of an active portal block."),
};

export const enterNetherPortalInputSchema = z.strictObject({
  ...coordinates,
  allow_low_supplies: z.boolean().default(false).describe("Proceed despite carrying fewer than 16 usable food items or 32 regular arrows. Return to the Overworld is exempt."),
});

export const enterEndPortalInputSchema = z.strictObject({
  ...coordinates,
  allow_low_supplies: z.boolean().default(false).describe("Proceed despite carrying fewer than 16 usable food items or 32 regular arrows."),
  respawn_within: z.number().nonnegative().default(128).describe("Maximum distance in blocks from the portal to a personal respawn bed confirmed through this session's sleep action."),
  allow_distant_respawn: z.boolean().default(false).describe("Enter the End when the personal respawn bed is distant or unknown. This bypasses only the respawn-distance guard."),
});

export interface PortalEntryRequest {
  readonly kind: "nether" | "end";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly allowLowSupplies: boolean;
  readonly respawnWithin: number;
  readonly allowDistantRespawn: boolean;
}

export const portalEntryResultSchema = actionResultSchema({ navigation: navigationEvidenceSchema });
export type PortalEntryResult = z.output<typeof portalEntryResultSchema>;
export type EnterNetherPortalOutput = ActionOutput<typeof ENTER_NETHER_PORTAL, PortalEntryResult>;
export type EnterEndPortalOutput = ActionOutput<typeof ENTER_END_PORTAL, PortalEntryResult>;

export function parseNetherPortalRequest(input: unknown): PortalEntryRequest {
  const value = enterNetherPortalInputSchema.parse(input ?? {});
  return { kind: "nether", x: value.x, y: value.y, z: value.z, allowLowSupplies: value.allow_low_supplies, respawnWithin: 128, allowDistantRespawn: false };
}

export function parseEndPortalRequest(input: unknown): PortalEntryRequest {
  const value = enterEndPortalInputSchema.parse(input ?? {});
  return { kind: "end", x: value.x, y: value.y, z: value.z, allowLowSupplies: value.allow_low_supplies, respawnWithin: value.respawn_within, allowDistantRespawn: value.allow_distant_respawn };
}
