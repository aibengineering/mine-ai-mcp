import { z } from "zod";
import { BodyAbort } from "../session/abort.js";
import { bodyAbortCauseSchema } from "../survival/evidence/contract.js";
import type { EndCombatResult } from "../survival/responses/end/execute.js";
import { actionResultSchema } from "./action.js";
import { crystalMeleeEvidenceSchema, dragonBowEvidenceSchema } from "./checkpoint-schemas.js";

export const endCombatEvidenceSchema = z.strictObject({
  outcome: z.enum(["crystal_destroyed", "shot_missed", "dragon_damaged", "weapon_unavailable", "perch_ready", "perch_approaching", "perch_ended", "dragon_died", "evaded", "stopped"]),
  attacks: z.number().int().nonnegative(),
  healthBefore: z.number().nullable(),
  healthAfter: z.number().nullable(),
  reason: z.string().nullable(),
  bow: dragonBowEvidenceSchema.optional(),
  perch: z.strictObject({
    preparedPosition: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
    stage: z.enum(["waiting", "preparing", "ready", "approaching_head", "attacking", "withdrawing"]),
    blockedBy: z.string().nullable(),
    timing: z.strictObject({
      elapsedMs: z.number().nonnegative(), firstDamageMs: z.number().nonnegative().nullable(),
      firstDamageInPerchMs: z.number().nonnegative().nullable(),
      confirmedDamage: z.number().nonnegative(), perchedTicks: z.number().int().nonnegative(),
      stageTicks: z.record(z.string(), z.number().int().nonnegative()), minimumHealth: z.number(),
      lastAttackBlocker: z.string().nullable(),
    }).optional(),
  }).optional(),
  crystal: z.strictObject({
    weapon: z.enum(["auto", "bow", "melee"]), approach: z.enum(["staircase", "pillar"]),
    usedWeapon: z.enum(["bow", "melee"]).nullable(),
    phase: z.enum(["selecting", "approaching", "aiming", "observing_blast", "returning", "settled"]),
    melee: crystalMeleeEvidenceSchema,
  }).optional(),
});
export const endCombatActionResultSchema = actionResultSchema({
  combat: endCombatEvidenceSchema,
  interruptedBy: bodyAbortCauseSchema.optional(),
});
export type EndCombatActionResult = z.output<typeof endCombatActionResultSchema>;
export function endCombatActionResult(combat: EndCombatResult): EndCombatActionResult {
  return combat.outcome === "stopped" || combat.outcome === "shot_missed" || combat.outcome === "weapon_unavailable"
    ? { status: "failed", error: combat.reason ?? "End combat stopped", combat }
    : { status: "succeeded", combat };
}

/** Cancellation retires authority while retaining already observed attacks and events. */
export function interruptedEndCombatResult(combat: EndCombatResult, cause: unknown): EndCombatActionResult {
  return {
    status: "cancelled",
    error: cause instanceof Error ? cause.message : String(cause),
    combat,
    interruptedBy: cause instanceof BodyAbort ? cause.detail : { kind: "cancelled", by: "runtime" },
  };
}
function describeBlast(melee: EndCombatActionResult["combat"]["crystal"] extends infer C ? C extends { melee: infer M } ? M : never : never): string {
  if (melee.blastExposure === null) return "blast stance not reached";
  const stance = melee.blastCoverCell
    ? `covered by the pedestal at ${melee.blastCoverCell.x},${melee.blastCoverCell.y},${melee.blastCoverCell.z}`
    : `exposed on the tower top (exposure ${melee.blastExposure}, estimated ${melee.estimatedBlastDamage} damage after armor)`;
  return `blast stance ${stance}; health lost to the explosion ${melee.explosionHealthLost ?? "not observed"}`;
}

export function formatEndCombatResult(result: EndCombatActionResult): string {
  return [
    `End combat: ${result.combat.outcome}.`,
    `${result.combat.attacks} attack(s) issued.`,
    ...(result.combat.healthBefore !== null
      ? [`Observed dragon health: ${result.combat.healthBefore} → ${result.combat.healthAfter ?? "unknown"}.`]
      : []),
    ...(result.combat.reason ? [result.combat.reason] : []),
    ...(result.combat.bow ? [`Bow stage: ${result.combat.bow.phase}; hitbox margin ${result.combat.bow.hitboxMargin} blocks; observed damage after release ${result.combat.bow.damageObserved}.`,
      ...(result.combat.bow.blockedBy ? [result.combat.bow.blockedBy] : [])] : []),
    ...(result.combat.perch
      ? [`Perch stage: ${result.combat.perch.stage}.${result.combat.perch.blockedBy ? ` ${result.combat.perch.blockedBy}` : ""}`]
      : []),
    ...(result.combat.perch?.preparedPosition
      ? [`Previously reached low position: ${result.combat.perch.preparedPosition.x}, ${result.combat.perch.preparedPosition.y}, ${result.combat.perch.preparedPosition.z}. Recheck current head and clouds before attacking.`]
      : []),
    ...(result.combat.perch?.timing
      ? [`Confirmed dragon damage: ${result.combat.perch.timing.confirmedDamage}; first damage ${result.combat.perch.timing.firstDamageInPerchMs ?? "not observed"} ms after observed perch entry (${result.combat.perch.timing.firstDamageMs ?? "not observed"} ms after request); ${result.combat.perch.timing.perchedTicks} perched ticks observed; minimum bot health ${result.combat.perch.timing.minimumHealth}.`]
      : []),
    ...(result.combat.crystal
      ? [`Weapon: ${result.combat.crystal.usedWeapon ?? result.combat.crystal.weapon}; approach: ${result.combat.crystal.approach}; phase: ${result.combat.crystal.phase}.`,
        `Melee: ${result.combat.crystal.melee.scaffoldPlaced} scaffold placed, ${result.combat.crystal.melee.scaffoldRecovered} recovered, ${result.combat.crystal.melee.cageBlocksDug} cage block(s) dug; first swing ${result.combat.crystal.melee.timeToFirstSwingMs ?? "not observed"} ms; ${describeBlast(result.combat.crystal.melee)}; returned to ground ${result.combat.crystal.melee.returnedToGround ? "yes" : "no"}.`]
      : []),
  ].join("\n\n");
}
