import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { nearGoal, type Navigate } from "../../navigation/index.js";
import { waitForSignal } from "../../utils/index.js";
import { findLoadedBlockPositions } from "../../world/loaded-block-scan.js";

// Stand beside the solid spawner, leaving room for navigation to choose safe footing.
const CAMP_RANGE = 3;

export function closestLoadedSpawner(bot: Bot): Vec3 | null {
  const spawner = bot.registry.blocksByName.spawner;
  if (!spawner) return null;
  const stateIds = new Set<number>();
  for (let id = spawner.minStateId; id <= spawner.maxStateId; id++) stateIds.add(id);
  return findLoadedBlockPositions(bot, { center: bot.entity.position, stateIds, limit: 1 })[0] ?? null;
}

export type CampFailure = {
  readonly termination: "spawner_unavailable" | "spawner_unreachable" | "observation_exhausted";
  readonly reason: string;
};

/** One request's remembered source. Navigation owns all physical movement. */
export class SpawnerCamp {
  readonly #dimension: string;
  #phase: "hunting" | "waiting_away" | "returning" | "waiting_at_spawner" = "hunting";
  #absenceStartedAt: number | null = null;
  #campWaitStartedAt: number | null = null;

  constructor(
    private readonly bot: Bot,
    readonly position: Vec3 | null,
    private readonly waitMs: number,
    private readonly returnTo: (position: Vec3, signal: AbortSignal) => ReturnType<Navigate>,
  ) {
    this.#dimension = bot.game.dimension;
  }

  get snapshot() {
    return {
      position: this.position ? { x: this.position.x, y: this.position.y, z: this.position.z } : null,
      dimension: this.#dimension,
      phase: this.#phase,
      returnAfter: this.#absenceStartedAt === null ? null : this.#absenceStartedAt + this.waitMs,
      observationUntil: this.#campWaitStartedAt === null ? null : this.#campWaitStartedAt + this.waitMs,
    };
  }

  unavailable(): CampFailure | null {
    if (!this.position)
      return {
        termination: "spawner_unavailable",
        reason: "[HUNT_SPAWNER_UNAVAILABLE] No loaded spawner was observed at admission.",
      };
    if (this.bot.game.dimension !== this.#dimension)
      return {
        termination: "spawner_unavailable",
        reason: "[HUNT_SPAWNER_UNAVAILABLE] The remembered spawner is in another dimension.",
      };
    const block = this.bot.blockAt(this.position);
    // Unloaded is unknown, not destroyed. Navigate back to the remembered source.
    if (block && block.name !== "spawner")
      return {
        termination: "spawner_unavailable",
        reason: `[HUNT_SPAWNER_UNAVAILABLE] The remembered spawner at ${this.position} is now ${block.name}.`,
      };
    return null;
  }

  #atCamp(): boolean {
    return this.position !== null && this.bot.entity.position.floored().distanceTo(this.position) <= CAMP_RANGE;
  }

  hunting(): void {
    this.#phase = "hunting";
    this.#absenceStartedAt = null;
    this.#campWaitStartedAt = null;
  }

  /** Preserve the away-wait deadline and return phase across reflex suspension. */
  async waitForQuarry(available: () => boolean, signal: AbortSignal): Promise<CampFailure | null> {
    for (;;) {
      signal.throwIfAborted();
      const missing = this.unavailable();
      if (missing) return missing;
      if (available()) {
        this.hunting();
        return null;
      }
      if (!this.#atCamp()) {
        this.#absenceStartedAt ??= Date.now();
        const remaining = this.#absenceStartedAt + this.waitMs - Date.now();
        if (remaining > 0) {
          this.#phase = "waiting_away";
          await waitForSignal(
            () => available() || this.unavailable(),
            this.bot,
            ["physicsTick", "entitySpawn", "entityUpdate", "blockUpdate"],
            { context: { signal }, timeoutMs: remaining },
          );
          signal.throwIfAborted();
          if (available() || this.unavailable()) continue;
        }
        this.#phase = "returning";
        const route = await this.returnTo(this.position!, signal);
        signal.throwIfAborted();
        if (route.status === "stopped")
          return { termination: "spawner_unreachable", reason: `[HUNT_SPAWNER_UNREACHABLE] ${route.reason}` };
        if (!this.#atCamp())
          return {
            termination: "spawner_unreachable",
            reason: "[HUNT_SPAWNER_UNREACHABLE] The return route ended outside the spawner's camp area.",
          };
      }
      this.#phase = "waiting_at_spawner";
      this.#campWaitStartedAt ??= Date.now();
      const remaining = this.#campWaitStartedAt + this.waitMs - Date.now();
      if (remaining <= 0)
        return {
          termination: "observation_exhausted",
          reason:
            "[HUNT_OBSERVATION_EXHAUSTED] No loaded quarry or requested inventory gain was observed within the requested wait at the spawner.",
        };
      // No repeated routes while already home. Suspension and displacement do
      // not renew this deadline; a dark room is not assumed to produce a mob.
      await waitForSignal(
        () => available() || this.unavailable() || !this.#atCamp(),
        this.bot,
        ["physicsTick", "entitySpawn", "entityUpdate", "blockUpdate"],
        { context: { signal }, timeoutMs: remaining },
      );
    }
  }
}

export function spawnerCampGoal(position: Vec3) {
  return nearGoal(position, CAMP_RANGE);
}
