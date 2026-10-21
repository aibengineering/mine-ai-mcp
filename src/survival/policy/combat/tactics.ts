/** Tactical policy receives the same surrounding danger for every selected target.
 * Severity is conservative: no invented precise blast/armour damage estimate. */
export interface CombatTacticalFacts {
  readonly creepers: readonly { id: number; distance: number; swelling: boolean; observed: boolean; exposed?: boolean; fuseRemainingTicks?: number }[];
  readonly clearancePending: boolean;
  readonly retreatPermitted: boolean;
  readonly escapeAvailable: boolean;
  readonly counterTarget: number | null;
  readonly counterReady: boolean;
  readonly barrier: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly stationaryCommitment: boolean;
  readonly footingRecovery: boolean;
  readonly shield: { available: boolean; raised: boolean };
  readonly projectile: { imminent: boolean; aligned: boolean; coversAll: boolean; impactInTicks: number | null } | null;
  /** A hostile in reach and facing the bot, whose next action is a hit. */
  readonly meleeImminent: boolean;
  /** The fight's current quarry. A fight passes it; other callers leave it out. */
  readonly quarryId?: number;
}
/** A creeper lights within three blocks of the player it follows; this leaves a block to start leaving. */
const CLOSE_EXPOSURE_DISTANCE = 4;
export type CombatTactic =
  | { readonly kind: "recover_footing" }
  | { readonly kind: "constrained"; readonly reason: "retreat_prohibited" }
  | { readonly kind: "escape"; readonly reason: "active_fuse" | "close_exposure" | "unfinished_clearance"; readonly threatIds: readonly number[] }
  | { readonly kind: "counter_blast"; readonly targetId: number }
  | { readonly kind: "blast_barrier"; readonly cell: { readonly x: number; readonly y: number; readonly z: number } }
  | { readonly kind: "brace_blast" }
  | { readonly kind: "guard" }
  | { readonly kind: "act" };

export function decideCombatTactic(facts: CombatTacticalFacts): CombatTactic {
  if (facts.footingRecovery) return { kind: "recover_footing" };
  const escape = creeperEscape(facts);
  if (escape) {
    // A ready swing still drops the shield. Leave its five-tick activation
    // delay plus two ticks for packet ordering before any nearby blast.
    if (facts.shield.available && facts.creepers.some(threat => threat.distance <= 8 && threat.swelling &&
      (threat.fuseRemainingTicks ?? 0) <= 7)) return { kind: "brace_blast" };
    if (facts.retreatPermitted && facts.escapeAvailable) return escape;
    // Multiple fuses make escape more urgent, but cannot make an unavailable
    // heading executable. Keep answering the same danger with feasible effects.
    if (facts.counterTarget !== null && facts.counterReady) return { kind: "counter_blast", targetId: facts.counterTarget };
    if (facts.barrier) return { kind: "blast_barrier", cell: facts.barrier };
    if (facts.retreatPermitted || facts.shield.available || facts.counterTarget !== null) return { kind: "brace_blast" };
    return { kind: "constrained", reason: "retreat_prohibited" };
  }
  // A creeper lights its fuse once it is within three blocks of the player it
  // follows and blows thirty ticks later unless that player is seven blocks
  // away by then. A fight with another enemy does not watch it walk in: in
  // r3-proof 2026-10-21T05-11-00-726Z (t00004) one crossed a tunnel from ten
  // blocks to 2.3 while Cave guarded against a skeleton, and the escape began
  // only with the fuse lit. When the quarry is another kind of enemy, a creeper
  // is answered at the close-exposure distance a bow's commitment already
  // uses, while leaving is still possible; the escape makes it the quarry. A
  // creeper quarry's own fight already strikes with knockback and clears.
  const creeperQuarry = facts.creepers.some(threat => threat.id === facts.quarryId);
  const incidental = facts.quarryId === undefined || creeperQuarry ? [] : facts.creepers.filter(threat =>
    threat.distance <= CLOSE_EXPOSURE_DISTANCE && threat.exposed !== false);
  if (incidental.length && facts.retreatPermitted && facts.escapeAvailable)
    return { kind: "escape", reason: "close_exposure", threatIds: incidental.map(threat => threat.id) };
  const projectile = facts.projectile;
  if (facts.shield.available && projectile &&
    (projectile.imminent || !projectile.aligned || !facts.shield.raised)) return { kind: "guard" };
  // A swing needs the guard up before it lands, and a raised shield does not
  // stop the bot fighting: unlike a volley, the answer to melee is to be
  // holding the shield while attacking, so this admits a guard only while it
  // is still down and lets the attack proceed once it is up.
  if (facts.shield.available && facts.meleeImminent && !facts.shield.raised) return { kind: "guard" };
  return { kind: "act" };
}

/** The same admission and release rule applies to a fight and an evasion guard. */
export function creeperEscape(facts: Pick<CombatTacticalFacts, "creepers" | "stationaryCommitment" | "clearancePending">): Extract<CombatTactic, { kind: "escape" }> | null {
  const fuses = facts.creepers.filter(threat => threat.distance <= 8 && threat.swelling);
  const closing = facts.stationaryCommitment ? facts.creepers.filter(threat => threat.distance <= CLOSE_EXPOSURE_DISTANCE && threat.exposed !== false) : [];
  const reason = fuses.length ? "active_fuse" : closing.length ? "close_exposure" : facts.clearancePending ? "unfinished_clearance" : null;
  return reason ? { kind: "escape", reason, threatIds: (fuses.length ? fuses : closing.length ? closing : facts.creepers).map(threat => threat.id) } : null;
}

/**
 * The creepers an escape adds to the clearance obligation. A live fuse or a
 * close exposure admits the creepers causing it. An unfinished clearance
 * admits none: its obligation already exists, and admitting every creeper in
 * sixteen blocks re-armed each one that clearance had just released. Two
 * creepers chasing a sprint then restarted each other's thirty ticks, and the
 * sprint ran on until one fell beyond a creeper's sixteen-block follow range
 * and gave up the chase. In combat-base 19-32-58-176Z both creepers were past
 * eight blocks twenty ticks into the sprint, which still ran 99 ticks and 22
 * blocks; a creeper left behind that way outlived the fight.
 */
export function creeperEscapeAdmits(escape: Extract<CombatTactic, { kind: "escape" }>): readonly number[] {
  return escape.reason === "unfinished_clearance" ? [] : escape.threatIds;
}
