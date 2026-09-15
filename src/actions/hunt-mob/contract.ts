import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const COLLECT_MOB_DROP = "collect_mob_drop" as const;
export const COLLECT_MOB_DROP_DESCRIPTION =
  "Collect an observed inventory gain of one exact drop from loaded mobs of one exact type. Approaches the selected quarry, delegates fighting to the shared combat controller under the current combat policy, then collects observed drops. Arrow collection automatically disables bow use for the entire request, including defensive interruptions, so collected arrows are not spent. Other combat permissions are preserved. This resource objective does not grant weapon, terrain, recovery, or engagement-health permissions. Automatic defensive pursuit preferences do not remove the explicitly requested quarry. Hostile quarry is refused outright unless a shield is carried and permitted, or allow_without_shield is passed to accept unblocked hits; passive quarry is unaffected. Completion requires the requested inventory gain and an observed safe handoff. Results separate collection termination from safe, unsafe, or interrupted handoff, and name observed mobs and item entities, positions, and pickup evidence. Item sightings alone do not identify which mob dropped them; disappearance alone does not prove pickup or destruction. Use set_survival_policy to change combat permissions.";

export const huntMobInputSchema = z
  .strictObject({
    mob_name: registryNameSchema.describe("Exact entity registry name, such as sheep, blaze, or enderman."),
    drop_name: registryNameSchema.describe(
      "Exact item registry name whose inventory gain is requested, such as white_wool.",
    ),
    count: z.number().int().positive().safe().default(1).describe("How many new drop items to collect."),
    observe_for_ms: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0)
      .describe(
        "Without camping: one finite observation window after the first absence of loaded quarry; zero returns immediately and the window never renews. With camp_spawner: required positive wait before returning, and a second wait of the same duration at the spawner. No quarry there returns observation_exhausted. Reflex suspension does not renew either deadline.",
      ),
    camp_spawner: z
      .boolean()
      .default(false)
      .describe(
        "Remember the closest loaded spawner at admission. After the absence wait, navigate back near that same spawner and wait once more for quarry. Requires positive observe_for_ms. Does not verify spawner mob type or spawn eligibility. Missing/destroyed spawners or failed return routes stop the request.",
      ),
    allow_without_shield: z
      .boolean()
      .default(false)
      .describe(
        "Fight a hostile species with no shield. Leave this out and a hostile quarry - skeleton, blaze, creeper, and every other mob in the hostile category, which includes hoglins, phantoms, slimes, magma cubes and ghasts - is refused before the first step unless a shield is carried and the combat policy permits shield use. Passing true is a deliberate choice to take unblocked hits for this request; it is not a fallback to retry with. Passive quarry such as chickens never needs it.",
      ),
  })
  .refine((value) => !value.camp_spawner || value.observe_for_ms > 0, {
    message: "camp_spawner requires a positive observe_for_ms to bound each absence wait.",
    path: ["observe_for_ms"],
  });

export interface HuntMobRequest {
  readonly mobName: string;
  readonly dropName: string;
  readonly count: number;
  readonly observeForMs: number;
  readonly campSpawner: boolean;
  /** Consent to fight a hostile species unshielded; meaningless for passive quarry. */
  readonly allowWithoutShield: boolean;
}

export function parseHuntMobRequest(input: unknown): HuntMobRequest {
  const value = huntMobInputSchema.parse(input ?? {});
  return {
    mobName: value.mob_name,
    dropName: value.drop_name,
    count: value.count,
    observeForMs: value.observe_for_ms,
    campSpawner: value.camp_spawner,
    allowWithoutShield: value.allow_without_shield,
  };
}

/**
 * One loaded mob the hunt saw, as it stood when the pursuit last scanned.
 *
 * The status view lists entities within sixteen blocks because it is built for
 * the fight, so nothing told a model where a rabbit sixty-five blocks off was
 * standing. The hunt's own sightings are what close that gap: a model that
 * reads a stop with a position in it can navigate closer and ask again.
 */
export const huntTargetSightingSchema = z.strictObject({
  species: z.string(),
  id: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  /** Blocks between the bot and the mob when the sighting was taken. */
  distance: z.number().nonnegative(),
});

export type HuntTargetSighting = z.output<typeof huntTargetSightingSchema>;

export const huntDropSightingSchema = z.strictObject({
  id: z.number().int(),
  item: z.string(),
  /** Last readable stack size, not a sum across merging entities or partial pickups. */
  observedCount: z.number().int().positive(),
  position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  /** Loaded block cells at the last item observation; null means unknown, not air. */
  blocks: z.strictObject({
    atPosition: z.string().nullable().describe("Block containing the item's last observed position; null if unloaded."),
    belowPosition: z
      .string()
      .nullable()
      .describe("Block one cell below that position; null if unloaded. This is not necessarily its landing surface."),
  }),
  /** Time of the sighting, so evidence from a terminated attempt is not mistaken for a fresh world scan. */
  observedAt: z.string().datetime(),
  firstSeen: z.enum(["already_loaded", "during_hunt"]),
  state: z.enum(["loaded", "no_longer_observed"]),
  /** A collection event identifies the collector; inventory gain remains the hunt's success proof. */
  collectedByBot: z.boolean(),
  collectedByOther: z.boolean(),
});
export type HuntDropSighting = z.output<typeof huntDropSightingSchema>;

export const huntRetargetSchema = z.strictObject({
  fromTargetId: z.number().int(),
  toTargetId: z.number().int(),
  position: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  distance: z.number().nonnegative(),
  reason: z.string(),
});

export const huntEvidenceSchema = z.strictObject({
  mob: z.string(),
  drop: z.string(),
  requested: z.number().int().positive(),
  gained: z.number().int().nonnegative(),
  inventoryBefore: z.number().int().nonnegative(),
  inventoryAfter: z.number().int().nonnegative(),
  targetsEngaged: z.number().int().nonnegative(),
  /** Actual selected-entity changes; excludes the first selection and same-target retries. */
  retargets: z.number().int().nonnegative(),
  targetChanges: z.array(huntRetargetSchema),
  targetDeathsObserved: z.number().int().nonnegative(),
  attacks: z.number().int().nonnegative(),
  /** Every way the controller fought across the hunt's engagements. */
  combatStyles: z.array(z.enum(["bow", "shielded_melee", "melee"])),
  /** Ranged windups - bow draws, blaze charges - met with a raised shield. */
  projectileGuards: z.number().int().nonnegative(),
  /** Items other than the requested drop picked up from the kills. */
  otherDropsCollected: z.number().int().nonnegative(),
  /** Every loaded mob the pursuit announced, nearest first. */
  targets: z.array(huntTargetSightingSchema),
  /** Observed item entities, including reflex-time drops; no claim that every item came from a hunted mob. */
  drops: z.array(huntDropSightingSchema),
});

export type HuntEvidence = z.output<typeof huntEvidenceSchema>;
export const huntHandoffSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("safe"),
    observedAt: z.number(),
    basis: z.enum(["clear", "separated", "sheltered"]),
    position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  z.strictObject({
    kind: z.literal("unsafe"),
    observedAt: z.number(),
    reason: z.string(),
    position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  z.strictObject({ kind: z.literal("interrupted"), reason: z.string() }),
]);
export const huntTerminationSchema = z.enum([
  "quantity_collected",
  "no_loaded_targets",
  "observation_exhausted",
  "spawner_unavailable",
  "spawner_unreachable",
  "targets_unreachable",
  "shield_required",
  "capability_blocked",
  "inventory_full",
  "inventory_changed",
  "interrupted",
  "execution_failed",
  "invalid_request",
]);
export type HuntTermination = z.output<typeof huntTerminationSchema>;
export const huntMobResultSchema = actionResultSchema({
  hunt: huntEvidenceSchema,
  termination: huntTerminationSchema,
  handoff: huntHandoffSchema,
});
export type HuntMobResult = z.output<typeof huntMobResultSchema>;
export type HuntMobOutput = ActionOutput<typeof COLLECT_MOB_DROP, HuntMobResult>;

export const huntMobAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const huntMobOutcomes = {
  /**
   * A hostile hunt admitted with nothing to block with.
   *
   * The refusal names the parameter that overrides it because a stop a model
   * cannot act on is a stop it will retry unchanged, and it says what the
   * override costs so that granting it stays a decision rather than a reflex.
   */
  shieldNotCarried: (mob: string) =>
    `[HUNT_NO_SHIELD] Refused before approaching: ${mob} is a hostile mob and no shield is carried. ` +
    `Craft or fetch a shield and equip it, or repeat this request with allow_without_shield: true to accept unblocked hits from this species.`,
  shieldNotPermitted: (mob: string) =>
    `[HUNT_NO_SHIELD] Refused before approaching: ${mob} is a hostile mob and, though a shield is carried, the combat policy forbids shield use, so the fight would be unshielded. ` +
    `Permit shields with set_survival_policy, or repeat this request with allow_without_shield: true to accept unblocked hits from this species.`,
  unknownMob: (mob: string) => `[UNKNOWN_HUNT_MOB] Minecraft has no entity registry entry named ${mob}.`,
  unknownDrop: (drop: string) => `[UNKNOWN_HUNT_DROP] Minecraft has no item registry entry named ${drop}.`,
  noLoadedTarget: (mob: string, drop: string, gained: number, requested: number) =>
    `[HUNT_TARGET_NOT_LOADED] No loaded ${mob} remained after observing ${drop} ${gained}/${requested}.`,
  tooHurt: (mob: string, health: number, minimum: number) =>
    `[HUNT_TOO_HURT] Health ${health} is below the ${minimum} needed to start a fight with a ${mob}; eat or rest first.`,
  /** The pursuit's own reason names where the mob was and how far, so the model can walk closer and ask again. */
  approachStopped: (mob: string, reason: string) =>
    `[HUNT_APPROACH_STOPPED] Could not complete an engagement with the selected ${mob}: ${reason}`,
  attackFailed: (mob: string, observation: string) =>
    `[HUNT_ATTACK_FAILED] Combat with the selected ${mob} failed: ${observation}`,
  combatStopped: (mob: string) => `[HUNT_COMBAT_STOPPED] The session stopped the fight with the selected ${mob}.`,
  botDied: (mob: string) => `[HUNT_BOT_DIED] The bot died fighting the selected ${mob}.`,
  dropApproachStopped: (drop: string, reason: string) =>
    `[HUNT_DROP_APPROACH_STOPPED] Pathfinder could not reach the observed ${drop} item: ${reason}.`,
  dropNotCollected: (drop: string) =>
    `[HUNT_DROP_NOT_COLLECTED] Pathfinder reached the observed ${drop} item without an inventory gain.`,
} as const;
