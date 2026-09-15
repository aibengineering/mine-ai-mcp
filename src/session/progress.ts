import { z } from "zod";
import type { RequestEvidence } from "./request.js";
import type { Facts } from "../survival/state/answered.js";
import { toolChanges, toolSnapshotSchema, type ToolSnapshot } from "../world/tool-tiers.js";

export const progressPositionSchema = z.strictObject({
  dimension: z.string(), x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
});
export type ProgressPosition = z.output<typeof progressPositionSchema>;
export const combatDurabilitySchema = z.strictObject({
  slot: z.number().int(), item: z.string(), before: z.number().int().nonnegative(), now: z.number().int().nonnegative(),
});
export const combatWeaponChangeSchema = z.strictObject({
  from: z.string().nullable(), to: z.string().nullable(), reason: z.string(),
});
export const combatResourcesSchema = z.strictObject({
  arrowsFired: z.number().int().nonnegative(),
  arrowsRecovered: z.number().int().nonnegative(),
  durabilityUsed: z.array(combatDurabilitySchema),
  shieldBlocks: z.number().int().nonnegative(),
  foodEaten: z.number().int().nonnegative(),
  scaffoldPlaced: z.number().int().nonnegative(),
  weaponChanges: z.array(combatWeaponChangeSchema),
});
export type CombatResources = z.output<typeof combatResourcesSchema>;
export type CombatResourceObservation =
  | { readonly kind: "arrow_fired" | "arrow_recovered" | "shield_block" | "food_eaten" | "scaffold_placed" }
  | { readonly kind: "durability_used"; readonly slot: number; readonly item: string; readonly before: number; readonly now: number }
  | { readonly kind: "weapon_changed"; readonly from: string | null; readonly to: string | null; readonly reason: string };

/** One occupied survival state: a reflex response in progress, a candidate response the
 * reflex withheld, or a combat controller phase. Entries count arrivals during this
 * request; activeMs is time spent in the state while this request owned reporting. */
export const reflexStateSchema = z.strictObject({
  kind: z.enum(["response", "withheld", "combat_phase"]),
  reflex: z.string(),
  name: z.string(),
  /** Why the reflex withheld this response: prohibited (a policy field), missing_equipment, answered, and so on. */
  exclusion: z.string().nullable(),
  detail: z.string().nullable(),
  entries: z.number().int().nonnegative(),
  activeMs: z.number().int().nonnegative(),
});
export type ReflexState = z.output<typeof reflexStateSchema>;
export type ReflexStateIdentity = Omit<ReflexState, "entries" | "activeMs">;
export const reflexActivitySchema = z.array(reflexStateSchema);
export type ReflexActivity = z.output<typeof reflexActivitySchema>;
/** `active` reports a state already occupied when this request was admitted: time accrues, no entry is counted. */
export type ReflexActivityObservation = {
  readonly kind: "entered" | "left" | "active";
  readonly state: ReflexStateIdentity;
};
export function reflexStateKey(state: ReflexStateIdentity): string {
  return [state.kind, state.reflex, state.name, state.exclusion ?? "", state.detail ?? ""].join("\u0000");
}

const emptyCombatResources = (): CombatResources => ({
  arrowsFired: 0, arrowsRecovered: 0, durabilityUsed: [], shieldBlocks: 0,
  foodEaten: 0, scaffoldPlaced: 0, weaponChanges: [],
});
export const progressSchema = z.strictObject({
  sampledAt: z.string(),
  positionSampledAt: z.string().nullable(),
  positionAgeMs: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().int().nonnegative(),
  suspendedMs: z.number().int().nonnegative(),
  distanceTravelledBlocks: z.number().nonnegative(),
  reflexDistanceBlocks: z.number().nonnegative(),
  distanceFromStartBlocks: z.number().nonnegative().nullable(),
  start: progressPositionSchema.nullable(),
  current: progressPositionSchema.nullable(),
  movementCoverage: z.strictObject({ complete: z.boolean(), discontinuities: z.array(z.string()) }),
  tools: toolSnapshotSchema,
  combatResources: combatResourcesSchema,
  reflexActivity: reflexActivitySchema,
  state: z.enum(["running", "suspended", "resuming", "stopping", "settled"]),
}).meta({ id: "MineAiProgress" });
export type Progress = z.output<typeof progressSchema>;

function distance(a: ProgressPosition, b: ProgressPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** One measurement lifetime, independent of physical attempts and observers. */
export class RequestProgress {
  readonly #started = performance.now();
  readonly #start: ProgressPosition | null;
  #position: ProgressPosition | null;
  #travel = 0;
  #reflexTravel = 0;
  #suspended = 0;
  #suspendedSince: number | null = null;
  #state: Progress["state"] = "running";
  #lastSample = performance.now();
  #positionSampledAt: string | null;
  #discontinuities = new Set<string>();
  #finished: Progress | null = null;
  readonly #tools: () => ToolSnapshot;
  readonly #combatResources = emptyCombatResources();
  readonly #reflexActivity = new Map<string, { state: ReflexStateIdentity; entries: number; activeMs: number; openedAt: number | null }>();

  constructor(position: ProgressPosition | null, tools: () => ToolSnapshot = () => ({ tools: [], armour: [] })) {
    this.#start = position ? { ...position } : null;
    this.#position = this.#start;
    this.#positionSampledAt = position ? new Date().toISOString() : null;
    if (!position) this.#discontinuities.add("initial_position_unavailable");
    this.#tools = tools;
  }

  transition(state: Progress["state"]): void {
    if (this.#finished) return;
    const now = performance.now();
    if (state === "suspended" && this.#suspendedSince === null) this.#suspendedSince = now;
    if (state !== "suspended" && state !== "resuming" && state !== "stopping" && this.#suspendedSince !== null) {
      this.#suspended += now - this.#suspendedSince;
      this.#suspendedSince = null;
    }
    this.#state = state;
  }

  sample(position: ProgressPosition | null, reflex: boolean, discontinuity?: string): void {
    if (this.#finished) return;
    const now = performance.now();
    // Missing a second of physical samples makes straight-line reconstruction unreliable.
    const gap = discontinuity ?? (now - this.#lastSample > 1000 ? "observation_gap" : undefined);
    const before = this.#position;
    if (gap) this.#discontinuities.add(gap);
    if (!position) this.#discontinuities.add("position_unavailable");
    if (before && position && before.dimension !== position.dimension) this.#discontinuities.add("dimension_change");
    if (!gap && before && position && before.dimension === position.dimension) {
      const travelled = distance(before, position);
      this.#travel += travelled;
      if (reflex) this.#reflexTravel += travelled;
    }
    this.#position = position ? { ...position } : null;
    this.#positionSampledAt = position ? new Date().toISOString() : null;
    this.#lastSample = now;
  }

  /** Record one observed combat cost while this foreground request owns the reporting lifetime. */
  combatResource(observation: CombatResourceObservation): void {
    if (this.#finished) return;
    switch (observation.kind) {
      case "arrow_fired": this.#combatResources.arrowsFired++; break;
      case "arrow_recovered": this.#combatResources.arrowsRecovered++; break;
      case "shield_block": this.#combatResources.shieldBlocks++; break;
      case "food_eaten": this.#combatResources.foodEaten++; break;
      case "scaffold_placed": this.#combatResources.scaffoldPlaced++; break;
      case "durability_used": {
        const previous = this.#combatResources.durabilityUsed.findLast((entry) => entry.slot === observation.slot && entry.item === observation.item);
        if (previous?.now === observation.before) previous.now = observation.now;
        else this.#combatResources.durabilityUsed.push({
          slot: observation.slot, item: observation.item, before: observation.before, now: observation.now,
        });
        break;
      }
      case "weapon_changed": this.#combatResources.weaponChanges.push({ from: observation.from, to: observation.to, reason: observation.reason }); break;
    }
  }

  /** Record a survival state boundary while this request owns the reporting lifetime. */
  reflexActivity(observation: ReflexActivityObservation): void {
    if (this.#finished) return;
    const key = reflexStateKey(observation.state);
    const now = performance.now();
    let entry = this.#reflexActivity.get(key);
    if (!entry) {
      entry = { state: { ...observation.state }, entries: 0, activeMs: 0, openedAt: null };
      this.#reflexActivity.set(key, entry);
    }
    if (observation.kind === "left") {
      if (entry.openedAt === null) return;
      entry.activeMs += now - entry.openedAt;
      entry.openedAt = null;
      return;
    }
    // A repeated arrival without an exit is one occupation, whatever the publisher did.
    if (observation.kind === "entered" && entry.openedAt === null) entry.entries++;
    entry.openedAt ??= now;
  }

  snapshot(): Progress {
    if (this.#finished) return structuredClone(this.#finished);
    const now = performance.now();
    const discontinuities = [...this.#discontinuities];
    if (now - this.#lastSample > 1000 && !discontinuities.includes("observation_gap")) discontinuities.push("observation_gap");
    return {
      sampledAt: new Date().toISOString(),
      positionSampledAt: this.#positionSampledAt,
      positionAgeMs: this.#positionSampledAt === null ? null : Math.round(now - this.#lastSample),
      elapsedMs: Math.round(now - this.#started),
      suspendedMs: Math.round(this.#suspended + (this.#suspendedSince === null ? 0 : now - this.#suspendedSince)),
      distanceTravelledBlocks: this.#travel,
      reflexDistanceBlocks: this.#reflexTravel,
      distanceFromStartBlocks: this.#start && this.#position && this.#start.dimension === this.#position.dimension
        ? distance(this.#start, this.#position) : null,
      start: this.#start ? { ...this.#start } : null,
      current: this.#position ? { ...this.#position } : null,
      movementCoverage: { complete: discontinuities.length === 0, discontinuities },
      tools: this.#tools(),
      combatResources: structuredClone(this.#combatResources),
      reflexActivity: [...this.#reflexActivity.values()].map((entry) => ({
        ...entry.state,
        entries: entry.entries,
        activeMs: Math.round(entry.activeMs + (entry.openedAt === null ? 0 : now - entry.openedAt)),
      })),
      state: this.#state,
    };
  }

  finish(): Progress {
    if (!this.#finished) {
      this.transition("settled");
      this.#finished = this.snapshot();
    }
    return this.snapshot();
  }
}

function factsObject(value: Facts | undefined): value is { readonly [name: string]: Facts } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Each waiter owns its baseline; reading never changes another observer's interval. */
export function progressChange(before: Progress, after: Progress, initial: RequestEvidence | null, final: RequestEvidence | null) {
  const first = initial?.checkpoint;
  const last = final?.checkpoint;
  const checkpointDelta: Record<string, number> = {};
  // Only explicit counters are additive. Coordinates, target IDs, and phases are not.
  for (const key of ["gained", "broken", "inventory", "attacks", "targetDeathsObserved", "completed", "collected", "produced", "furnaceOutput", "goldOffers", "goldSpent", "expandedChunks", "correct"]) {
    const a = first && typeof first === "object" && !Array.isArray(first) ? first[key] : undefined;
    const b = last && typeof last === "object" && !Array.isArray(last) ? last[key] : undefined;
    if (typeof a === "number" && typeof b === "number") checkpointDelta[key] = b - a;
  }
  if (factsObject(first) && factsObject(last) && Array.isArray(first.items) && Array.isArray(last.items)) {
    for (const item of last.items) {
      if (!factsObject(item) || typeof item.item !== "string") continue;
      const previous = first.items.find((entry) => factsObject(entry) && entry.item === item.item);
      if (!factsObject(previous)) continue;
      for (const key of ["gained", "current", "removed"]) {
        if (typeof previous[key] === "number" && typeof item[key] === "number") checkpointDelta[`items.${item.item}.${key}`] = item[key] - previous[key];
      }
    }
  }
  return {
    from: before.sampledAt, to: after.sampledAt,
    elapsedMs: after.elapsedMs - before.elapsedMs,
    suspendedMs: after.suspendedMs - before.suspendedMs,
    distanceTravelledBlocks: after.distanceTravelledBlocks - before.distanceTravelledBlocks,
    reflexDistanceBlocks: after.reflexDistanceBlocks - before.reflexDistanceBlocks,
    combatResources: {
      arrowsFired: after.combatResources.arrowsFired - before.combatResources.arrowsFired,
      arrowsRecovered: after.combatResources.arrowsRecovered - before.combatResources.arrowsRecovered,
      durabilityUsed: after.combatResources.durabilityUsed.flatMap((entry, index) => {
        // Intervals are append-only. Index, rather than value identity, keeps
        // two replacement stacks with the same starting wear distinct.
        const previous = before.combatResources.durabilityUsed[index];
        const sameInterval = previous?.slot === entry.slot && previous.item === entry.item && previous.before === entry.before;
        const usedBefore = sameInterval ? previous.now : entry.before;
        return entry.now > usedBefore ? [{ ...entry, before: usedBefore }] : [];
      }),
      shieldBlocks: after.combatResources.shieldBlocks - before.combatResources.shieldBlocks,
      foodEaten: after.combatResources.foodEaten - before.combatResources.foodEaten,
      scaffoldPlaced: after.combatResources.scaffoldPlaced - before.combatResources.scaffoldPlaced,
      weaponChanges: after.combatResources.weaponChanges.slice(before.combatResources.weaponChanges.length),
    },
    reflexActivity: after.reflexActivity.flatMap((state) => {
      const previous = before.reflexActivity.find((entry) => reflexStateKey(entry) === reflexStateKey(state));
      const entries = state.entries - (previous?.entries ?? 0);
      const activeMs = state.activeMs - (previous?.activeMs ?? 0);
      return entries > 0 || activeMs > 0 ? [{ ...state, entries, activeMs }] : [];
    }),
    checkpointDelta,
    toolChanges: toolChanges(before.tools, after.tools),
  };
}
