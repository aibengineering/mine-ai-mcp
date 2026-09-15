import { z } from "zod";
import { combatPolicySchema, DEFAULT_COMBAT_POLICY } from "./combat/contract.js";
export const DEFAULT_SCAFFOLD_BLOCKS = Object.freeze([
  "dirt",
  "cobblestone",
  "cobbled_deepslate",
  "netherrack",
  "basalt",
  "end_stone",
]);

/**
 * The survival policy: the rules every automatic response follows when the
 * model is not driving the body, grouped by the domain each rule governs.
 *
 * Reflexes are the model's only way to influence what the bot does on its
 * own, so this one object is the whole surface. New reflex knobs join an
 * existing group or add one; nothing tunable lives anywhere else.
 */
export const foodPolicySchema = z.strictObject({
  raw: z
    .strictObject({
      allow: z
        .enum(["emergency_only", "always", "never"])
        .describe(
          "When automatic eating (the hunger reflex and combat recovery) may spend uncooked food such as beef, porkchop, cod, or potato. " +
            "emergency_only keeps it for cooking until one of the floors below is crossed. Explicit eat_food requests are never affected.",
        ),
      hunger_at_most: z
        .number()
        .finite()
        .min(0)
        .max(20)
        .describe("Under emergency_only, uncooked food may be eaten once hunger is at or below this. Sprinting stops at six."),
      health_below: z
        .number()
        .finite()
        .min(0)
        .max(20)
        .describe(
          "Under emergency_only, uncooked food may also be eaten to heal while health is below this and hunger is under the regeneration bar of 18.",
        ),
    })
    .describe("Uncooked food is worth far more cooked; this rule stops a hunt from eating its own drops."),
});
export type FoodPolicy = z.infer<typeof foodPolicySchema>;
export const DEFAULT_FOOD_POLICY: Readonly<FoodPolicy> = Object.freeze({
  // Sprinting stops at six hunger; ten is half health, where the fight and
  // hide decisions already treat the bot as in trouble.
  raw: Object.freeze({ allow: "emergency_only", hunger_at_most: 6, health_below: 10 }),
});

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

export const survivalPolicySchema = z.strictObject({
  navigation: navigationPolicySchema.describe("Threat avoidance when choosing routes."),
  combat: combatPolicySchema.describe(
    "Automatic combat: engagement, hiding, recovery, retreat, permitted weapons and terrain, health thresholds, and tactical budgets.",
  ),
  food: foodPolicySchema.describe("Automatic eating: the hunger reflex and every recovery that eats."),
});
export type SurvivalPolicy = z.infer<typeof survivalPolicySchema>;
export const DEFAULT_SURVIVAL_POLICY: Readonly<SurvivalPolicy> = Object.freeze({
  navigation: DEFAULT_NAVIGATION_POLICY,
  combat: DEFAULT_COMBAT_POLICY,
  food: DEFAULT_FOOD_POLICY,
});

/** A deep partial of the policy: name only the fields being set. */
export const changesSchema = z
  .strictObject({
    navigation: navigationPolicySchema.partial().optional(),
    combat: combatPolicySchema
      .partial()
      .extend({ terrain: combatPolicySchema.shape.terrain.partial().optional() })
      .optional(),
    food: z.strictObject({ raw: foodPolicySchema.shape.raw.partial().optional() }).optional(),
  })
  .describe("Only the fields named here change; each becomes its own override under the given lifetime.");
export type PolicyChanges = z.infer<typeof changesSchema>;

export const conditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("health_at_least"), value: z.number().min(0).max(20) }),
  z.strictObject({
    kind: z.literal("carried_item_at_least"),
    item: z.string().min(1),
    count: z.number().int().positive(),
  }),
]);
export type PolicyCondition = z.infer<typeof conditionSchema>;

/** Every override says how long it lasts; nothing the model sets persists by accident. */
export const policyLifetimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session") }).describe("Until reset, death, dimension change, or disconnect."),
  z
    .strictObject({ kind: z.literal("encounter"), encounter_id: z.string().min(1) })
    .describe("Until the named active encounter ends."),
  z
    .strictObject({ kind: z.literal("until"), condition: conditionSchema })
    .describe("Until the observed health or carried-item condition holds."),
  z
    .strictObject({ kind: z.literal("for"), duration_ms: z.number().int().positive().max(3_600_000) })
    .describe("For a fixed time, at most an hour."),
]);
export type PolicyLifetime = z.infer<typeof policyLifetimeSchema>;

const expectedRevision = z
  .string()
  .min(1)
  .describe("Current survivalPolicy.revision from any reply; a stale revision is refused.");
const reason = z
  .string()
  .min(1)
  .max(240)
  .describe("Why, in your own words. Kept beside the override and in the policy's history.");

export const policyEditSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("set"),
    expected_revision: expectedRevision,
    changes: changesSchema,
    lifetime: policyLifetimeSchema,
    reason,
  }),
  z.strictObject({
    operation: z.literal("clear"),
    expected_revision: expectedRevision,
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .describe("Override paths to remove, such as combat.hide or food.raw.allow; those fields return to defaults."),
    reason,
  }),
  z.strictObject({ operation: z.literal("reset"), expected_revision: expectedRevision, reason }),
]);
export type PolicyEdit = z.infer<typeof policyEditSchema>;

export const policyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()).readonly()]);
export type PolicyValue = z.infer<typeof policyValueSchema>;

export const policyOverrideSchema = z.strictObject({
  /** Dotted path to the field, such as combat.terrain.dig. */
  path: z.string(),
  value: policyValueSchema,
  lifetime: policyLifetimeSchema,
  reason: z.string(),
  since: z.number(),
  /** When a timed lifetime ends, as epoch milliseconds; null for the other kinds. */
  expiresAt: z.number().nullable(),
});
export type PolicyOverride = z.infer<typeof policyOverrideSchema>;

export const policySnapshotSchema = z.strictObject({
  revision: z.string(),
  defaults: survivalPolicySchema,
  effective: survivalPolicySchema,
  /** Every live override, one per field, sorted by path. */
  overrides: z.array(policyOverrideSchema),
  encounter: z.string().nullable(),
  response: z
    .strictObject({ kind: z.enum(["fight", "hide", "evade", "deflect"]), reason: z.string(), revision: z.string() })
    .nullable(),
  settling: z.boolean(),
  lastChange: z.string(),
  constraint: z.string().nullable(),
}).meta({ id: "MineAiSurvivalPolicySnapshot" });
export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The scalar fields of a (partial) policy as dotted paths, in declaration order. */
export function flattenPolicyLeaves(value: unknown, prefix = ""): [string, PolicyValue][] {
  if (!isPlainObject(value)) return [];
  const leaves: [string, PolicyValue][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) leaves.push(...flattenPolicyLeaves(entry, path));
    else leaves.push([path, entry as PolicyValue]);
  }
  return leaves;
}

/** Every path an override may name. */
export const SURVIVAL_POLICY_PATHS: ReadonlySet<string> = new Set(
  flattenPolicyLeaves(DEFAULT_SURVIVAL_POLICY).map(([path]) => path),
);

export function describeLifetime(lifetime: PolicyLifetime): string {
  switch (lifetime.kind) {
    case "session":
      return "for the session";
    case "encounter":
      return `for encounter ${lifetime.encounter_id}`;
    case "until":
      return lifetime.condition.kind === "health_at_least"
        ? `until health reaches ${lifetime.condition.value}`
        : `until carrying ${lifetime.condition.count} ${lifetime.condition.item}`;
    case "for":
      return `for ${Math.round(lifetime.duration_ms / 1000)} s`;
  }
}
