import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Visibility budgets, not combat deadlines. A healthy wait is reported after
 * fifteen seconds (the existing protected-wait diagnostic window); unanswered
 * damage is reported after five seconds, one complete blaze attack cooldown. */
export const COMBAT_WAIT_NOTICE_MS = 15_000;
const DAMAGING_STALL_NOTICE_MS = 5_000;

export const combatProgressSchema = z.object({
  engagementId: z.string(),
  startedAt: z.number(),
  elapsedMs: z.number(),
  inactiveMs: z.number(),
  state: z.enum(["advancing", "waiting", "stall"]),
  lastProgress: z.string().nullable(),
  confirmedTargetHits: z.number(),
  confirmedDefensiveHits: z.number(),
  completedVolleys: z.number(),
  recoveredHealth: z.number(),
  healthLost: z.number(),
});
export type CombatProgressSnapshot = z.output<typeof combatProgressSchema>;
export type CombatProgressChange = "progress" | "waiting" | "stall" | "resumed";

/** One engagement owns this history across phases, routes and incidental targets.
 * Repeating a command is activity. Only an observed outcome advances the objective.
 * Defensive work is counted separately: useful defence can coexist with a blocked hunt. */
export class CombatProgress {
  readonly #id = randomUUID();
  readonly #startedAt: number;
  #lastAdvanceAt: number;
  #lastProgress: string | null = null;
  #state: CombatProgressSnapshot["state"] = "advancing";
  #reported: "waiting" | "stall" | null = null;
  #health: number | null = null;
  #healthAtAdvance: number | null = null;
  #targetHits = 0;
  #defensiveHits = 0;
  #volleys = 0;
  #recoveredHealth = 0;
  #changed = false;
  // Naturally scoped to this fight. Replans, cell oscillations and repeated
  // protection checks must not manufacture fresh milestones.
  readonly #milestones = new Set<string>();

  constructor(atMs = Date.now()) {
    this.#startedAt = this.#lastAdvanceAt = atMs;
  }

  milestone(kind: "route_step" | "attack_position" | "protection", identity: string, atMs = Date.now()): void {
    const key = `${kind}:${identity}`;
    if (this.#milestones.has(key)) return;
    this.#milestones.add(key);
    this.#advance(kind, atMs);
  }

  confirmedHit(requestedTarget: boolean, atMs = Date.now()): void {
    if (requestedTarget) {
      this.#targetHits++;
      this.#advance("confirmed_target_damage", atMs);
    } else this.#defensiveHits++;
  }

  volleyFinished(): void {
    this.#volleys++;
  }

  #advance(reason: string, atMs: number): void {
    this.#lastAdvanceAt = atMs;
    this.#lastProgress = reason;
    this.#healthAtAdvance = this.#health;
    this.#changed = true;
  }

  observe(health: number, atMs = Date.now()): CombatProgressChange | null {
    if (this.#health !== null && health > this.#health) this.#recoveredHealth += health - this.#health;
    this.#health = health;
    this.#healthAtAdvance ??= health;
    if (this.#changed) {
      this.#changed = false;
      const change = this.#reported === null ? "progress" : "resumed";
      this.#state = "advancing";
      this.#reported = null;
      return change;
    }
    const inactiveMs = atMs - this.#lastAdvanceAt;
    const damaged = health < this.#healthAtAdvance;
    const state =
      damaged && inactiveMs >= DAMAGING_STALL_NOTICE_MS
        ? "stall"
        : inactiveMs >= COMBAT_WAIT_NOTICE_MS
          ? "waiting"
          : "advancing";
    // A wait can escalate to damage, but healing alone cannot erase a blocked
    // objective or re-emit the same wait every time health changes.
    // Keep the live safety description current after healing, while remembering
    // which notices were already emitted for this unchanged objective.
    this.#state = this.#reported === "stall" && !damaged ? "waiting" : state;
    if (state === "advancing" || state === this.#reported || this.#reported === "stall") return null;
    this.#reported = state;
    return state;
  }

  snapshot(atMs = Date.now()): CombatProgressSnapshot {
    return {
      engagementId: this.#id,
      startedAt: this.#startedAt,
      elapsedMs: atMs - this.#startedAt,
      inactiveMs: atMs - this.#lastAdvanceAt,
      state: this.#state,
      lastProgress: this.#lastProgress,
      confirmedTargetHits: this.#targetHits,
      confirmedDefensiveHits: this.#defensiveHits,
      completedVolleys: this.#volleys,
      recoveredHealth: this.#recoveredHealth,
      healthLost: Math.max(0, (this.#healthAtAdvance ?? 0) - (this.#health ?? 0)),
    };
  }
}
