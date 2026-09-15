import type { Bot } from "mineflayer";
import type { NavigationEvent } from "../../src/navigation/index.ts";
import type { MovementKind } from "../../src/navigation/movements/movement.ts";
import type { MovementPhase } from "../../src/navigation/orchestration/outcome.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import { startMemoryProbe } from "./memory-probe.ts";

/** Everything one scenario observed of navigation, summarised for its report. */
export interface PathfinderTrace {
  summary(): string;
  onEvent(listener: (event: NavigationEvent) => void): () => void;
  close(): void;
}

function increment(counts: Partial<Record<MovementKind, number>>, movement: MovementKind): void {
  counts[movement] = (counts[movement] ?? 0) + 1;
}

function progressNode(node: {
  position: { x: number; y: number; z: number };
  heuristic: number;
  routeCost: number;
  depth: number;
}): string {
  return `${node.position.x},${node.position.y},${node.position.z} h=${node.heuristic.toFixed(2)} g=${node.routeCost.toFixed(2)} depth=${node.depth}`;
}

/** Visited nodes per compute millisecond across every search, the figure the search budgets are sized by. */
function searchRate(totals: ReadonlyMap<string, { visited: number; computeMs: number }>): string {
  let visited = 0;
  let computeMs = 0;
  for (const total of totals.values()) {
    visited += total.visited;
    computeMs += total.computeMs;
  }
  return computeMs > 0 ? `${(visited / computeMs).toFixed(1)} visited/ms over ${computeMs.toFixed(0)} ms` : "no search";
}

function wrapDegrees(degrees: number): number {
  let wrapped = degrees % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped < -180) wrapped += 360;
  return wrapped;
}

/**
 * What a spectator sees of the bot's head while a step is being walked.
 *
 * A turn of 90 degrees or more between two physics ticks is a snap; two snaps
 * that cancel within eight ticks are a spin there and back. A backtrack tick
 * moves the body against the step's planned heading, which is the walk back
 * to a cell centre the bot had already passed.
 */
function observeHeading(bot: Bot, log: (line: string) => void) {
  const steps = new Map<string, { readonly dx: number; readonly dz: number }>();
  const active = new Set<string>();
  let previousYaw: number | null = null;
  let previous: { x: number; z: number } | null = null;
  let navigatingTicks = 0;
  let turns90 = 0;
  let turns150 = 0;
  let spinPairs = 0;
  let backtrackTicks = 0;
  let lastSnap: { readonly turn: number; readonly tick: number } | null = null;
  const onTick = () => {
    const yaw = (bot.entity.yaw * 180) / Math.PI;
    const { x, z } = bot.entity.position;
    const turn = previousYaw === null ? 0 : wrapDegrees(yaw - previousYaw);
    const moved = previous ? { x: x - previous.x, z: z - previous.z } : { x: 0, z: 0 };
    previousYaw = yaw;
    previous = { x, z };
    if (active.size === 0) return;
    navigatingTicks += 1;
    // A climb has no horizontal heading and few ticks; every one of them is
    // worth a line when a column is being entered or left.
    for (const stepId of active)
      if (stepId.includes(":climb:"))
        log(
          `climb tick ${x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${z.toFixed(2)} ` +
            `${bot.entity.onGround ? "grounded" : "airborne"} vy=${bot.entity.velocity.y.toFixed(3)} ` +
            `[${(["forward", "back", "left", "right", "jump", "sneak"] as const).filter((control) => bot.getControlState(control)).join(",")}] ${stepId.split(":").slice(0, 2).join(":")}`,
        );
    if (Math.abs(turn) >= 90) {
      turns90 += 1;
      if (Math.abs(turn) >= 150) turns150 += 1;
      const held = (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const)
        .filter((control) => bot.getControlState(control))
        .join(",");
      log(
        `heading snap ${turn.toFixed(0)}deg to ${yaw.toFixed(0)}deg at ${x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${z.toFixed(2)} ` +
          `${bot.entity.onGround ? "grounded" : "airborne"} [${held}] during ${[...active].join(" ")}`,
      );
      if (lastSnap && navigatingTicks - lastSnap.tick <= 8 && Math.abs(wrapDegrees(lastSnap.turn + turn)) < 45) {
        spinPairs += 1;
        lastSnap = null;
      } else lastSnap = { turn, tick: navigatingTicks };
    }
    for (const stepId of active) {
      const heading = steps.get(stepId);
      if (heading && moved.x * heading.dx + moved.z * heading.dz < -0.02) {
        backtrackTicks += 1;
        break;
      }
    }
  };
  bot.on("physicsTick", onTick);
  return {
    observe(event: NavigationEvent) {
      if (event.kind === "route_committed") {
        // A new plan supersedes every step of the last one, including a step
        // an invalidation abandoned without a completed or failed event.
        active.clear();
        for (const step of event.plan.steps) {
          const dx = step.to.x - step.from.x;
          const dz = step.to.z - step.from.z;
          const length = Math.hypot(dx, dz);
          if (length > 0) steps.set(step.id, { dx: dx / length, dz: dz / length });
        }
      } else if (event.kind === "step_started") active.add(event.stepId);
      else if (event.kind === "step_completed" || event.kind === "step_failed") active.delete(event.stepId);
      else if (event.kind === "run_settled") active.clear();
    },
    summary: () =>
      `heading turns >=90deg ${turns90}, >=150deg ${turns150}, spin pairs ${spinPairs}, ` +
      `backtrack ticks ${backtrackTicks} over ${navigatingTicks} navigating ticks`,
    close() {
      bot.off("physicsTick", onTick);
    },
  };
}

/** Observe the production navigation runtime; scenarios never install one of their own. */
export function installScenarioPathfinder(bot: Bot, context: MineAiScenarioContext): PathfinderTrace {
  const heading = observeHeading(bot, context.log);
  const listeners = new Set<(event: NavigationEvent) => void>();
  const attempted: Partial<Record<MovementKind, number>> = {};
  const succeeded: Partial<Record<MovementKind, number>> = {};
  const failed: Partial<Record<MovementKind, number>> = {};
  const phaseMilliseconds: Partial<Record<MovementPhase, number>> = {};
  const activePhases = new Map<string, { readonly phase: MovementPhase; readonly atMs: number }>();
  const replanReasons: Record<string, number> = {};
  const worldChanges = { expected: 0, conflicting: 0, invalidating: 0, irrelevant: 0 };
  const movementFailures: string[] = [];
  const memory = startMemoryProbe();
  let searches = 0;
  let searchSlices = 0;
  let replans = 0;
  let continuations = 0;
  let plans = 0;
  let plannedSteps = 0;
  let maximumVisited = 0;
  /** The last slice of every search, so the rate is visited over compute across the whole run. */
  const searchTotals = new Map<string, { visited: number; computeMs: number }>();
  let maximumGenerated = 0;

  const observe = (event: NavigationEvent): void => {
    for (const listener of [...listeners]) listener(event);
    heading.observe(event);

    if (event.kind === "step_phase") {
      const previous = activePhases.get(event.stepId);
      if (previous) {
        phaseMilliseconds[previous.phase] = (phaseMilliseconds[previous.phase] ?? 0) + event.atMs - previous.atMs;
      }
      activePhases.set(event.stepId, { phase: event.phase, atMs: event.atMs });
    } else if (event.kind === "step_completed" || event.kind === "step_failed") {
      const previous = activePhases.get(event.stepId);
      if (previous) {
        phaseMilliseconds[previous.phase] = (phaseMilliseconds[previous.phase] ?? 0) + event.atMs - previous.atMs;
        activePhases.delete(event.stepId);
      }
    }

    if (event.kind === "search_started") {
      searches += 1;
      if (event.reason === "segment_continuation" || event.reason === "arrival_continuation") continuations += 1;
      else if (event.reason !== "initial") {
        replans += 1;
        replanReasons[event.reason] = (replanReasons[event.reason] ?? 0) + 1;
      }
    } else if (event.kind === "search_slice") {
      searchSlices += 1;
      maximumVisited = Math.max(maximumVisited, event.visited);
      searchTotals.set(event.searchId, { visited: event.visited, computeMs: event.computeMs });
      maximumGenerated = Math.max(maximumGenerated, event.generated);
      if (event.checkpoint) {
        const checkpoint = event.checkpoint;
        context.log(
          `navigation partial_route ${checkpoint.outcome} at ${checkpoint.threshold} visited, ` +
            `selected by ${checkpoint.selectedBy}, open ${checkpoint.openNodes}; ` +
            `start ${progressNode(checkpoint.start)}; closest ${progressNode(checkpoint.closest)}; ` +
            `selected ${progressNode(checkpoint.selected)}` +
            (checkpoint.closestGenerated ? `; closest generated ${progressNode(checkpoint.closestGenerated)}` : "") +
            (checkpoint.mostPermissiveProgress
              ? `; best progress /${checkpoint.mostPermissiveProgress.coefficient} ` +
                `${checkpoint.mostPermissiveProgress.score.toFixed(2)} must be below ` +
                `${checkpoint.mostPermissiveProgress.requiredBelow.toFixed(2)} at ` +
                progressNode(checkpoint.mostPermissiveProgress.node)
              : ""),
        );
      }
    } else if (event.kind === "route_committed") {
      plans += 1;
      plannedSteps += event.steps;
    } else if (event.kind === "step_started") increment(attempted, event.movement);
    else if (event.kind === "step_completed") increment(succeeded, event.movement);
    else if (event.kind === "step_failed") {
      increment(failed, event.movement);
      movementFailures.push(`${event.movement} ${event.stepId}: ${event.observation}`);
    } else if (event.kind === "world_change") worldChanges[event.classification] += 1;

    // World-change classifications remain in the summary counters. Printing
    // every receipt made one progression run emit more than 27,000 identical
    // `irrelevant` lines and buried the movement failure being investigated.
    if (event.kind !== "search_slice" && event.kind !== "step_phase" && event.kind !== "world_change") {
      const detail =
        event.kind === "step_failed"
          ? ` ${event.observation}`
          : event.kind === "search_started"
            ? ` ${event.goal}`
            : "";
      context.log(`navigation ${event.kind} ${"stepId" in event ? event.stepId : ""}${detail}`.trim());
    }
  };

  const stopObserving = context.navigation.onEvent(observe);

  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    summary: () =>
      `searches ${searches}, search slices ${searchSlices}, plans ${plans}, replans ${replans}, ` +
      `continuations ${continuations}, replan reasons ${JSON.stringify(replanReasons)}, planned steps ${plannedSteps}, ` +
      `world changes ${JSON.stringify(worldChanges)}, maximum visited ${maximumVisited}, maximum generated ${maximumGenerated}, ` +
      `search rate ${searchRate(searchTotals)}, ` +
      `movement attempted ${JSON.stringify(attempted)}, succeeded ${JSON.stringify(succeeded)}, failed ${JSON.stringify(failed)}, ` +
      (movementFailures.length > 0 ? `failure observations ${JSON.stringify(movementFailures)}, ` : "") +
      `phase ms ${JSON.stringify(phaseMilliseconds)}, ${heading.summary()}, ${memory.summary()}`,
    close() {
      stopObserving();
      listeners.clear();
      heading.close();
      memory.close();
    },
  };
}
