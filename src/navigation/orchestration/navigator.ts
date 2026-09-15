/**
 * Admission: one navigation run at a time, and the handle that observes it.
 *
 * The navigator decides who may move the bot. It does not search, and it does
 * not execute — those belong to `search/` and `execution/`.
 */
import type { NavigationBot } from "../bot.js";
import { ExpectedMutationLedger } from "../execution/mutations.js";
import type { Goal } from "../goals/goal.js";
import { createMovementCatalogue, type MovementCatalogue } from "../movements/catalogue.js";
import type { MovementPolicy } from "../movements/policy.js";
import type { SearchLimits } from "../search/search-result.js";
import type { StepFieldProvider } from "../step-field.js";
import { silentTelemetry, type TelemetrySink } from "../telemetry/index.js";
import type { WorldView } from "../world/world.js";
import { NavigationRun, type RunContext } from "./navigation-run.js";
import type { NavigationOutcome, NavigationStatus } from "./outcome.js";
import type {
  NavigationArrival,
  NavigationArrivalResult,
  NavigationCalculationFailureEvent,
  NavigationCalculationFailureResult,
} from "./process-events.js";

export interface NavigationRequest {
  readonly goal: Goal;
  readonly policy: MovementPolicy;
  /**
   * Resolve a reached spatial goal without necessarily ending this run.
   *
   * Ordinary navigation omits this and completes on arrival. A process such
   * as mining can pause movement, act at the reached cell, then continue with
   * the same dynamic goal and run lifetime.
   */
  readonly onArrival?: (arrival: NavigationArrival) => NavigationArrivalResult | Promise<NavigationArrivalResult>;
  /**
   * Resolve an inline calculation failure without necessarily ending this run.
   *
   * Baritone reports `CALC_FAILED` to the active process. Mining uses that
   * event to blacklist the closest target from the player's current position,
   * revise its composite goal, and continue under the same pathing lifetime.
   */
  readonly onCalculationFailure?: (
    event: NavigationCalculationFailureEvent,
  ) => NavigationCalculationFailureResult | Promise<NavigationCalculationFailureResult>;
  /** Stops the run; the abort reason becomes the stopped outcome's reason. */
  readonly signal?: AbortSignal;
  /** Search budget used while the bot is waiting for its first route or a replan. */
  readonly searchLimits?: SearchLimits;
  /** Larger plan-ahead budget used while the current partial route is already being walked. */
  readonly continuationSearchLimits?: SearchLimits;
  /**
   * Opts this run out of the registered step field.
   *
   * `null` opts out and is the only value a caller can supply, because
   * supplying a field of its own is not something a request may do. Absent, or
   * undefined, means the registered provider. The field is a standing property
   * of the runtime so that every route gets it without wiring, and the routes
   * that must not have it - combat walking toward the thing the field prices -
   * say so here.
   */
  readonly stepField?: null | undefined;
}

export interface NavigationHandle {
  readonly runId: string;
  readonly outcome: Promise<NavigationOutcome>;
  cancel(reason?: string): void;
}

export type NavigationAdmission =
  | { readonly kind: "started"; readonly handle: NavigationHandle }
  | { readonly kind: "busy"; readonly activeRunId: string };

export interface Navigator {
  startRun(request: NavigationRequest): NavigationAdmission;
  /**
   * Register the one provider every search here asks for its step field.
   *
   * Registered rather than passed per call: avoidance is a property of the bot,
   * not of one route, and a per-call option would be one more thing for every
   * caller to remember and for a model to get wrong.
   */
  setStepFieldProvider(provider: StepFieldProvider): void;
  readonly active: NavigationStatus | null;
  cancelActive(reason?: string): void;
  terminateActive(reason: string): void;
}

export function createNavigator(dependencies: {
  readonly world: WorldView;
  readonly bot: NavigationBot;
  readonly catalogue?: MovementCatalogue;
  readonly telemetry?: TelemetrySink;
  readonly createId?: () => string;
}): Navigator {
  let activeRun: NavigationRun | undefined;
  let activeControl: AbortController | undefined;
  let activeStatus: NavigationStatus | null = null;
  let sequence = 0;
  const ledger = new ExpectedMutationLedger();
  const catalogue = dependencies.catalogue ?? createMovementCatalogue();
  const telemetry = dependencies.telemetry ?? silentTelemetry;
  const createId = dependencies.createId ?? (() => `navigation-${Date.now()}-${++sequence}`);
  let stepFieldProvider: StepFieldProvider | null = null;
  return {
    get active() {
      return activeStatus;
    },
    setStepFieldProvider(provider) {
      stepFieldProvider = provider;
    },
    startRun(request: NavigationRequest): NavigationAdmission {
      if (activeRun) return { kind: "busy", activeRunId: activeRun.context.runId };
      const runId = createId();
      // The navigator's own stop, composed with the caller's: the run sees one
      // signal and never learns who aborted it.
      const control = new AbortController();
      const context: RunContext = {
        runId,
        world: dependencies.world,
        bot: dependencies.bot,
        catalogue,
        ledger,
        telemetry,
        signal: request.signal ? AbortSignal.any([request.signal, control.signal]) : control.signal,
        // The request either opted out with an explicit null, or said nothing
        // and gets whatever is registered - which is itself null until the
        // session registers one.
        stepField: request.stepField === null ? null : stepFieldProvider,
      };
      const run = new NavigationRun({
        context,
        request,
        status: (status) => {
          if (activeRun === run) activeStatus = status;
        },
        release: () => {
          if (activeRun === run) {
            activeRun = undefined;
            activeControl = undefined;
          }
        },
      });
      activeRun = run;
      activeControl = control;
      const outcome = run.execute();
      return { kind: "started", handle: { runId, outcome, cancel: (reason = "cancelled") => control.abort(reason) } };
    },
    cancelActive(reason = "cancelled") {
      activeControl?.abort(reason);
    },
    terminateActive(reason) {
      activeControl?.abort(reason);
      activeRun?.terminate();
    },
  };
}
