import type { Continuation } from "../../session/abort.js";
import type { AnsweredEntry, AnsweredScope, Facts } from "../state/answered.js";
import type { REFLEX_PRIORITY } from "./priority.js";
export type ReflexName = (typeof REFLEX_PRIORITY)[number];

export type DangerObservation<Danger> =
  | { readonly kind: "observed"; readonly danger: Danger; readonly evidence: Facts }
  | { readonly kind: "unknown"; readonly missing: string }
  | null;

export type ResponseExclusion =
  | { readonly kind: "prohibited"; readonly field: string }
  | { readonly kind: "missing_equipment"; readonly item: string }
  | { readonly kind: "unsuitable_geometry"; readonly scope: string }
  | { readonly kind: "answered"; readonly entry: number }
  | { readonly kind: "infeasible_now"; readonly premise: string };

export type ResponseDecision<Response> =
  | { readonly kind: "respond"; readonly response: Response; readonly name: string; readonly reason: string }
  | {
      readonly kind: "stand_down";
      readonly candidates: readonly { readonly response: string; readonly excluded: ResponseExclusion }[];
    }
  | { readonly kind: "handled"; readonly by: string };

export interface ReflexDefinition<Danger, Response, Outcome> {
  readonly name: ReflexName;
  readonly intervalTicks?: number;
  sense(): DangerObservation<Danger>;
  decide(danger: Danger): ResponseDecision<Response>;
  /** Captured only on a changed decision, so physics updates cannot flood receipts. */
  decisionFacts?(danger: Danger): Facts;
  facts(response: Response): AnsweredScope;
  act(response: Response, signal: AbortSignal): Promise<Outcome>;
  continuation(outcome: Outcome): Continuation;
  failure(outcome: Outcome): AnsweredEntry["failure"] | null;
  describe(outcome: Outcome): Facts;
  /** An actual temporal dependency, never an automatic retry delay. */
  temporal?(outcome: Outcome): AnsweredEntry["temporal"];
  releaseAfterAdmission?(): void;
  settled?(response: Response, outcome: Outcome, interrupted: { action: string; startedAt: string } | null): void;
}

export interface ReflexSnapshot {
  readonly name: ReflexName;
  readonly danger: Facts;
  readonly missing: string | null;
  readonly observedAt: number | null;
  readonly stale: boolean;
  readonly decision: Facts;
  readonly response: { readonly name: string; readonly startedAt: number; readonly releasing: boolean } | null;
}

export interface SurvivalTransition {
  readonly kind: "danger" | "decision" | "claim" | "phase" | "outcome";
  readonly reflex: ReflexName;
  readonly evidence: Facts;
}
