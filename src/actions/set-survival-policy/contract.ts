import { z } from "zod";
import { changesSchema, policyLifetimeSchema } from "../../survival/policy/contract.js";

export const SET_SURVIVAL_POLICY = "set_survival_policy" as const;
export const SET_SURVIVAL_POLICY_DESCRIPTION =
  "Change the connected bot's survival policy: the rules its automatic responses follow whenever the model is not driving the body. " +
  "Groups: navigation (scaffold_blocks: preferred automatic building blocks; hostile_avoidance_multiplier: route caution, default 1; bucket_fall_save: emergency water rescue, default true; bucket_drops: planned water drops, default true), " +
  "combat (engagement, hiding, recovery, retreat, melee, bow, shield, terrain, health thresholds, tactical budgets) and " +
  "food (raw: when uncooked food may be eaten automatically). " +
  "set merges the named fields as overrides, each carrying the lifetime you give it, so an encounter tweak never disturbs a session setting; " +
  "clear removes overrides by path such as combat.hide or food.raw.allow; reset restores every default. " +
  "expected_revision comes from survivalPolicy in any reply. Every edit needs a reason in your own words; it is kept beside the override and in the policy's history. " +
  "Waits for affected responses to release the body; does not dig an exit or choose a destination. Fire, breath, and footing reflexes remain independent.";

/** The tool's flat input; the discriminated policy edit schema validates the combination. */
export const setSurvivalPolicyInputSchema = z.strictObject({
  operation: z
    .enum(["set", "clear", "reset"])
    .describe("set merges the named fields as overrides under one lifetime; clear removes overrides by path; reset restores every default."),
  expected_revision: z
    .string()
    .min(1)
    .describe("Current survivalPolicy.revision from any reply; a stale revision is refused."),
  changes: changesSchema.optional().describe("Required for set: the fields to override, grouped as navigation, combat and food."),
  lifetime: policyLifetimeSchema
    .optional()
    .describe("Required for set: session, the named active encounter, an until condition, or a fixed duration."),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .optional()
    .describe("Required for clear: override paths to remove, such as combat.hide or food.raw.allow."),
  reason: z
    .string()
    .min(1)
    .max(240)
    .describe("Why, in your own words. Kept beside each override and in the policy's history."),
});
