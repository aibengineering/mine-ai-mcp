import type { Continuation } from "../../session/abort.js";
import type { AnsweredEntry, AnsweredScope } from "../state/answered.js";
import type { REFLEX_PRIORITY } from "./priority.js";
import type { Facts } from "../../utils/facts.js";
import type { ResponseDecision } from "../policy/decision.js";
export type ReflexName = (typeof REFLEX_PRIORITY)[number];

export type DangerObservation<Danger> =
  | { readonly kind: "observed"; readonly danger: Danger; readonly evidence: Facts }
  | { readonly kind: "unknown"; readonly missing: string }
  | null;





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
  releaseAfterAdmission?(): void;
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
