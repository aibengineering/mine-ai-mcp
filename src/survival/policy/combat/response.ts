import type { Position3 } from "../../../utils/index.js";
export interface HostileThreat {
  readonly id: number;
  readonly name: string;
  readonly position: Position3;
  readonly distance: number;
}

export type EvadeReason = "hurt" | "creeper" | "unreachable" | "observed_aggression" | "withdraw";

export type HideReason = "hurt" | "cornered";

export type HostileDirective =
  | { readonly kind: "none" }
  | { readonly kind: "constrained"; readonly reason: string }
  | {
      readonly kind: "deflect";
      readonly targetId: number;
      readonly threats: readonly HostileThreat[];
      readonly reason: "incoming_fireball";
    }
  | { readonly kind: "fight"; readonly targetId: number; readonly threats: readonly HostileThreat[] }
  | { readonly kind: "hide"; readonly threats: readonly HostileThreat[]; readonly reason: HideReason }
  | {
      readonly kind: "evade";
      readonly threats: readonly HostileThreat[];
      readonly safeRange: number;
      readonly reason: EvadeReason;
    };

export type HostileResponse = Exclude<HostileDirective, { kind: "none" | "constrained" }>;
