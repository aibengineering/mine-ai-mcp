/** Why a candidate response was ruled out. */
export type ResponseExclusion =
  | { readonly kind: "prohibited"; readonly field: string }
  | { readonly kind: "missing_equipment"; readonly item: string }
  | { readonly kind: "unsuitable_geometry"; readonly scope: string }
  | { readonly kind: "answered"; readonly entry: number }
  | { readonly kind: "infeasible_now"; readonly premise: string };

/** What a decision returns: a response to run, a stand-down with every exclusion, or another owner's. */
export type ResponseDecision<Response> =
  | { readonly kind: "respond"; readonly response: Response; readonly name: string; readonly reason: string }
  | {
      readonly kind: "stand_down";
      readonly candidates: readonly { readonly response: string; readonly excluded: ResponseExclusion }[];
    }
  | { readonly kind: "handled"; readonly by: string };
