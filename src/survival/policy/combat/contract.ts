import { z } from "zod";
export const combatPolicySchema = z.strictObject({
  engagement: z
    .enum(["respond_to_threats", "defend_only"])
    .describe("Automatic pursuit preference; explicitly requested quarry remains a resource objective."),
  hide: z
    .enum(["never", "when_recovery_possible", "when_exposed"])
    .describe(
      "Permission for automatic enclosure. when_exposed also permits emergency cover without healing prerequisites; ordinary shelter triggers still apply.",
    ),
  recover: z
    .enum(["never", "when_possible"])
    .describe("Permit recovery inside an independently permitted combat response."),
  retreat: z.boolean().describe("Permit combat-owned separation movement, without specifying a travel destination."),
  melee: z.boolean(),
  bow: z.boolean(),
  shield: z.boolean(),
  terrain: z
    .strictObject({ dig: z.boolean(), place: z.boolean() })
    .describe("Combat-owned terrain changes and approaches. Ordinary navigation keeps its own dig/scaffold arguments."),
  engage_min_health: z
    .number()
    .finite()
    .min(0)
    .max(20)
    .describe("Health points required for a pursuing hostile engagement; immediate contact defence remains separate."),
  critical_health: z
    .number()
    .finite()
    .min(0)
    .max(20)
    .describe("Below this health, observed nearby threats can trigger emergency protection before contact."),
  recover_to_health: z
    .number()
    .finite()
    .min(0)
    .max(20)
    .describe("Health sought before resuming combat; never lower than engage_min_health for hostile pursuit."),
  protected_wait_ticks: z
    .number()
    .int()
    .positive()
    .describe(
      "Physics ticks without confirmed quarry damage before abandoning a fighting refuge. Recovery pauses this window.",
    ),
  enderman_wait_ticks: z
    .number()
    .int()
    .positive()
    .describe("Physics ticks allowed for Enderman provocation or waiting for confirmed damage under a roof."),
  volley_wait_ticks: z
    .number()
    .int()
    .positive()
    .describe("Physics ticks allowed to observe a ranged volley finish before reporting the guard exhausted."),
  recovery_timeout_ms: z
    .number()
    .int()
    .positive()
    .describe("Milliseconds allowed for one protected recovery; routes and eating never renew this hold."),
  evade_timeout_ms: z
    .number()
    .int()
    .positive()
    .describe("Milliseconds allowed for one emergency withdrawal, including projectile defence and route changes."),
  evade_safe_range: z
    .number()
    .finite()
    .positive()
    .describe("Observed block distance required from each threat before combat withdrawal counts as separation."),
});
export type CombatPolicy = z.infer<typeof combatPolicySchema>;
export const DEFAULT_COMBAT_POLICY: Readonly<CombatPolicy> = Object.freeze({
  engagement: "respond_to_threats",
  hide: "when_recovery_possible",
  recover: "when_possible",
  retreat: true,
  melee: true,
  bow: true,
  shield: true,
  terrain: Object.freeze({ dig: true, place: true }),
  engage_min_health: 12,
  critical_health: 8,
  recover_to_health: 18,
  protected_wait_ticks: 300,
  enderman_wait_ticks: 300,
  volley_wait_ticks: 100,
  recovery_timeout_ms: 90_000,
  evade_timeout_ms: 15_000,
  evade_safe_range: 36,
});
