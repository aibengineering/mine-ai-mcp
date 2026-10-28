import { z } from "zod";

/** Navigation's section of the survival policy: what routes may place, drop and avoid. */
export const DEFAULT_SCAFFOLD_BLOCKS = Object.freeze([
  "dirt",
  "cobblestone",
  "cobbled_deepslate",
  "netherrack",
  "basalt",
  "end_stone",
]);

export const navigationPolicySchema = z.strictObject({
  scaffold_blocks: z
    .array(z.string().min(1))
    .max(16)
    .readonly()
    .describe(
      "Carried block names automatic navigation and survival responses may place as scaffold, in preference order. An empty list disables automatic scaffold placement.",
    ),
  bucket_fall_save: z.boolean().describe("Automatically use carried water to save a damaging fall on a loaded safe full-block floor, then verify water recovery. Unavailable in the Nether."),
  bucket_drops: z.boolean().describe("Permit planned water-bucket drops up to 80 blocks onto loaded safe full-block floors; require a carried water bucket and verified recovery before continuing. Independent of scaffolding."),
  hostile_avoidance_multiplier: z
    .number()
    .finite()
    .nonnegative()
    .describe(
      "Multiplier on capped hostile proximity route cost: 1 is normal, 2 doubles it, 0.5 halves it, 0 removes proximity cost. " +
        "Applies to ordinary navigation and evasion; deliberate combat approaches remain exempt. " +
        "Does not change species radii, critical-health exposure cost, or engagement decisions. Read at each route search.",
    ),
});
export type NavigationPolicy = z.infer<typeof navigationPolicySchema>;
export const DEFAULT_NAVIGATION_POLICY: Readonly<NavigationPolicy> = Object.freeze({
  scaffold_blocks: DEFAULT_SCAFFOLD_BLOCKS,
  hostile_avoidance_multiplier: 1,
  bucket_fall_save: true,
  bucket_drops: true,
});
