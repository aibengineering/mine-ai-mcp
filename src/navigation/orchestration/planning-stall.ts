import type { NavigationObservation, Position3 } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";

const STALL_MS = 20_000;

/** One stationary planning window across retries, never a deadline for executing a route. */
export class PlanningStall {
  #window: { atMs: number; position: Position3; dimension: string } | null = null;

  begin(observation: NavigationObservation, now = performance.now()): void {
    this.#window ??= { atMs: now, position: { ...observation.position }, dimension: observation.dimension };
  }

  committed(): void {
    this.#window = null;
  }

  check(observation: NavigationObservation, now = performance.now()): NavigationFailure | null {
    const window = this.#window;
    if (!window) return null;
    const { position } = observation;
    // Measure displacement from an anchor, not accumulated motion: jitter and
    // the one-block vertical surface bob cannot keep renewing this window.
    if (observation.dimension !== window.dimension ||
        Math.hypot(position.x - window.position.x, position.z - window.position.z) >= 1 ||
        Math.abs(position.y - window.position.y) >= 2) {
      this.#window = { atMs: now, position: { ...position }, dimension: observation.dimension };
      return null;
    }
    const elapsedMs = now - window.atMs;
    return elapsedMs >= STALL_MS ? {
      kind: "no_progress", reason: "planning_stalled",
      observation: `Path planning stalled for ${Math.round(elapsedMs)} ms without a route commitment or meaningful displacement (1 block horizontally or 2 vertically); limit ${STALL_MS} ms. Repeated search invalidation does not renew this limit.`,
    } : null;
  }
}
