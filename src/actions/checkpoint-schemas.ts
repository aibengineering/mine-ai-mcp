import { z } from "zod";
import { equipmentSlotsSchema } from "./equip/contract.js";

const position = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
const phase = z.string();
const count = z.number();

// Each action opts into its checkpoint contract. These schemas describe observed
// evidence, not a universal percentage or a new completion policy.
export const navigateCheckpointSchema = z.strictObject({
  destination: position.nullable(), remainingDistance: count.nullable(), dimension: z.string(),
  positionedDimension: z.string(), died: z.boolean(),
  portal: z.strictObject({ block: z.string(), cell: z.string() }).nullable(),
});
export const collectCheckpointSchema = z.strictObject({ broken: count, gained: count, requested: count });
export const pickupCheckpointSchema = z.strictObject({
  observed: count, collected: count, currentTargetId: count.nullable(), currentTargetDistance: count.nullable(),
});
export const huntCheckpointSchema = z.strictObject({
  phase, selectedTargetId: count.nullable(), attacks: count, targetDeathsObserved: count, inventory: count, gained: count,
  requested: count, observationStartedAt: count.nullable(), observationUntil: count.nullable(),
  camp: z.strictObject({ position: position.nullable(), dimension: z.string(), phase,
    returnAfter: count.nullable(), observationUntil: count.nullable() }).nullable(),
});
export const buildCheckpointSchema = z.strictObject({ phase, correct: count, requested: count, remaining: count, placed: count });
export const craftCheckpointSchema = z.strictObject({ phase, items: z.array(z.strictObject({
  item: z.string(), initial: count, current: count, gained: count, requested: count,
})) });
export const smeltCheckpointSchema = z.strictObject({ phase, requested: count, produced: count,
  outputItem: z.string().nullable(), furnaceOutput: count, fuelInserted: count,
  furnaceInput: count, furnaceFuel: count, cookProgress: count.nullable(), fuelProgress: count.nullable(),
  stalledForMs: count });
export const barterCheckpointSchema = z.strictObject({ phase, gained: count, requested: count, goldOffers: count, goldSpent: count, goldBudget: count });
export const equipCheckpointSchema = z.strictObject({ phase, completed: count, requested: count, equipment: equipmentSlotsSchema });
export const dropCheckpointSchema = z.strictObject({ phase, freeSlots: count,
  items: z.array(z.strictObject({ item: z.string(), requested: count, before: count, current: count, removed: count })) });
export const eatCheckpointSchema = z.strictObject({ phase, item: z.string(), inventory: count, hunger: count, saturation: count });
export const containerCheckpointSchema = z.strictObject({ phase, inventory: z.record(z.string(), count), windowOpen: z.boolean(),
  requested: z.array(z.strictObject({ itemName: z.string(), count })) });
export const placeCheckpointSchema = z.strictObject({ phase, inventory: count, target: position.nullable(), currentBlock: z.string().nullable() });
export const bucketCheckpointSchema = z.strictObject({ phase, held: z.string().nullable(), target: position.nullable(),
  targetBlock: z.string().nullable(), used: z.boolean(), obsidianFormed: count, cobblestoneFormed: count });
export const exploreCheckpointSchema = z.strictObject({ phase, expandedChunks: count, requested: count, enteredBiome: position.nullable() });
export const strongholdCheckpointSchema = z.strictObject({ phase, throwIds: z.array(z.string()),
  estimate: z.strictObject({ x: count, z: count }).nullable(), confirmed: z.boolean() });
export const portalCheckpointSchema = z.strictObject({ phase, block: z.string().nullable(),
  filledSockets: count.optional(), portalCells: count.optional(), requiredPortalCells: count.optional() });
export const sleepCheckpointSchema = z.strictObject({ phase, asleep: z.boolean(), timeOfDay: count });
export const dragonCheckpointSchema = z.strictObject({
  entered: z.boolean(), ended: z.boolean(), died: z.boolean(), attacks: count, health: count.nullable(),
  stage: z.enum(["waiting", "preparing", "ready", "approaching_head", "attacking", "withdrawing"]).optional(),
  preparedPosition: position.nullable().optional(), blockedBy: z.string().nullable().optional(),
});
export const dragonBowEvidenceSchema = z.strictObject({
  phase: z.enum(["aiming", "observing", "settled"]), nativePhase: count.nullable(),
  flightTicks: count.nullable(), damageObserved: count, blockedBy: z.string().nullable(), hitboxMargin: count,
});
export const dragonShotCheckpointSchema = dragonBowEvidenceSchema.extend({
  attacks: count, health: count.nullable(), died: z.boolean(),
});
export const crystalMeleeEvidenceSchema = z.strictObject({
  scaffoldPlaced: count, scaffoldRecovered: count, cageBlocksDug: count,
  timeToFirstSwingMs: count.nullable(), highestFeetY: count,
  swingFromPlannedStance: z.boolean().nullable(), swingDistance: count.nullable(),
  blastCoverCell: position.nullable(), blastExposure: z.number().min(0).max(1).nullable(),
  estimatedBlastDamage: z.number().nonnegative().nullable(), explosionHealthLost: count.nullable(),
  returnedToGround: z.boolean(), returnTimeMs: count.nullable(),
  abortReason: z.enum(["stance_unreachable", "cage_uncleared", "blast_unsafe", "dragon_contact"]).nullable(),
});
export const crystalCheckpointSchema = z.strictObject({
  phase: z.enum(["selecting", "approaching", "aiming", "observing_blast", "returning", "settled"]),
  weapon: z.enum(["auto", "bow", "melee"]), approach: z.enum(["staircase", "pillar"]),
  usedWeapon: z.enum(["bow", "melee"]).nullable(),
  attacks: count, destroyed: z.boolean(), melee: crystalMeleeEvidenceSchema,
  shot: z.strictObject({ flightTicks: count, firstServerAge: count.nullable(), settled: z.boolean() }).nullable(),
});
export const executionCheckpointSchema = z.strictObject({ phase: z.literal("executing") });
