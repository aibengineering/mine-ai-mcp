import { z } from "zod";
import { combatPolicySchema } from "./contract.js";
import { decideCombatResponse, type CombatDecisionFacts } from "./decision.js";
import { decideFightBoundary } from "./fight-boundary.js";
import { decideHostileReflex } from "./reflex-decision.js";

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });
const threat = z.object({ id: z.number(), name: z.string(), position, distance: z.number() });
const inputs = z.object({
  policy: combatPolicySchema,
  health: z.number(),
  burning: z.boolean(),
  hideAllowed: z.boolean(),
  recoveryAvailable: z.boolean(),
  weapon: z.boolean(),
  rangedWeapon: z.boolean(),
  shield: z.boolean(),
  fireball: threat.nullable(),
  unreachable: z.array(z.number()),
  // Older incident captures predate target-specific exclusion inputs.
  answeredFights: z.array(z.tuple([z.number(), z.number()])).default([]),
  answered: z.array(z.string()),
  contacts: z.array(
    threat.extend({
      relationship: z.object({
        avoid: z.boolean(),
        defend: z.boolean(),
        attention: z.enum(["on_sight", "observed_attack", "inferred_head_gaze", "unknown"]),
      }),
      inContact: z.boolean(),
      inReach: z.boolean(),
      defendsOnContact: z.boolean(),
      ranged: z.boolean(),
      utility: z.object({
        inReach: z.boolean(),
        visible: z.boolean(),
        hasHitUs: z.boolean(),
        safeDropGround: z.boolean(),
        distance: z.number(),
      }),
    }),
  ),
});
const purpose = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automatic"), quarry: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("pursuit"), targetId: z.number(), minimumHealth: z.number() }),
  z.object({ kind: z.literal("contact_defence"), targetId: z.number() }),
  z.object({ kind: z.literal("recovery"), targetId: z.number().nullable() }),
  z.object({ kind: z.literal("handoff") }),
]);
const selection = z.object({ inputs, purpose });
const recordSchema = z.union([
  z.object({
    boundary: z.literal("fight"),
    selection,
    protection: z.object({
      returnable: z.boolean(),
      atProtection: z.boolean(),
      foodLow: z.boolean(),
      foodAvailable: z.boolean(),
    }),
  }),
  z.object({
    selection,
    settling: z.boolean(),
    combatOwnsBody: z.boolean(),
    entries: z.array(z.object({ response: z.string(), entry: z.number() })),
  }),
  selection,
]);

/** Replay a recorded decision input without a bot, world, policy store or clock. */
export function replayCombatDecision(recorded: unknown) {
  const record = recordSchema.parse(recorded);
  const selected = "selection" in record ? record.selection : record;
  const facts: CombatDecisionFacts = {
    ...selected.inputs,
    unreachable: new Set(selected.inputs.unreachable),
    answeredFights: new Map(selected.inputs.answeredFights),
    answered: new Set(selected.inputs.answered),
  };
  if ("boundary" in record) {
    if (selected.purpose.kind !== "pursuit" && selected.purpose.kind !== "contact_defence")
      throw new Error("A fight boundary requires a pursuit or contact-defence purpose.");
    return decideFightBoundary(facts, selected.purpose, record.protection);
  }
  const directive = decideCombatResponse(facts, selected.purpose);
  return "settling" in record
    ? decideHostileReflex({
        facts,
        directive,
        settling: record.settling,
        combatOwnsBody: record.combatOwnsBody,
        entries: record.entries,
      })
    : directive;
}
