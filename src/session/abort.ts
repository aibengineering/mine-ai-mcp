/** Why an owner must release. A dimension transition is never a death. */
export type BodyAbortCause =
  | { readonly kind: "preempted"; readonly by: string }
  | { readonly kind: "policy_changed"; readonly revision: string }
  | { readonly kind: "cancelled"; readonly by: "model" | "runtime" }
  | { readonly kind: "connection_lost" }
  | { readonly kind: "death" }
  | { readonly kind: "dimension_changed"; readonly from: string; readonly to: string };

/** Still an Error for physical APIs; consumers branch on the cause, never its prose. */
export class BodyAbort extends Error {
  constructor(
    readonly detail: BodyAbortCause,
    message: string,
  ) {
    super(message);
    this.name = "BodyAbort";
  }
}

export type Continuation =
  | { readonly kind: "resume" }
  | { readonly kind: "return"; readonly reason: string | null }
  | { readonly kind: "cancel"; readonly cause: BodyAbortCause };
