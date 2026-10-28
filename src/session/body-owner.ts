import type { BodyAbortCause, Continuation } from "./abort.js";
import type { RequestSnapshot } from "./request.js";

/**
 * The body as reflexes see it: who owns it, and how to take it. The action runner
 * implements this; survival depends on the port, never on the runner.
 */
export interface BodyOwner {
  claim<Value>(
    name: string,
    reason: string,
    work: (signal: AbortSignal) => Promise<ClaimSettlement<Value>>,
    releaseAfterAdmission?: () => void,
  ): BodyClaim<Value>;
  holdBaseline(name: string, release: () => void): boolean;
  releaseBaseline(name: string): void;
  onOwnershipChange(listener: () => void): () => void;
  ownership(): BodyOwnership;
  request(): RequestSnapshot | null;
  status(): ActionRunnerStatus;
}

export interface ActionRunnerStatus {
  busy: boolean;
  activeAction: { action: string; startedAt: string } | null;
  owner: "idle" | "foreground" | "yielding" | "takeover";
}

/** What a reflex reports when it releases the body. */
export interface ClaimSettlement<Value> {
  readonly value: Value;
  readonly continuation: Continuation;
}

export interface BodyOwnership {
  readonly current: string | null;
  readonly reserved: string | null;
  readonly transfer: { readonly from: string; readonly to: string; readonly cause: BodyAbortCause } | null;
  readonly connected: boolean;
}

/** What a reflex was handed, or why the body was not available to it. */
export type BodyClaim<Value> =
  | { readonly kind: "closed"; readonly cause: BodyAbortCause }
  | { readonly kind: "busy"; readonly activeAction: NonNullable<ActionRunnerStatus["activeAction"]> }
  | {
      readonly kind: "claimed";
      /** The action this claim preempted, or null when the body was already idle. */
      readonly interrupted: ActionRunnerStatus["activeAction"];
      readonly outcome: Promise<Value>;
    };
