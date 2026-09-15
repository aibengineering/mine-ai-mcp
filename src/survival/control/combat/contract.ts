import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { CrystalObservation } from "../../perception/combat/crystal.js";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import type { CombatPolicy } from "../../policy/combat/contract.js";
import { type CombatPositionPlan } from "../../positioning/combat/geometry.js";
import { type EndCombatResult } from "../../responses/end/execute.js";
import type { Facts } from "../../state/answered.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { type CombatExecutionSnapshot } from "./execution.js";
import { type CombatHandoff } from "./handoff.js";
import type { CombatProgressChange } from "./progress.js";
export type CombatStyle = "bow" | "shielded_melee" | "melee";

export type CombatDecision =
  | { readonly kind: "response"; readonly evidence: Facts }
  | { readonly kind: "phase"; readonly targetId: number; readonly phase: string; readonly completedEffects: number }
  | { readonly kind: "position_rejected"; readonly targetId: number; readonly position: Vec3; readonly reason: string }
  | {
      readonly kind: "recovery";
      readonly targetId: number;
      readonly state: "started" | "recovered" | "blocked";
      readonly reason: string;
    }
  | {
      readonly kind: "engagement";
      readonly state: "started" | "ended" | CombatProgressChange;
      readonly targetId: number;
      readonly targetDistance: number | null;
      readonly execution: CombatExecutionSnapshot;
      readonly outcome: string | null;
      readonly observation: string | null;
    }
  | { readonly kind: "roof_prepared"; readonly targetId: number; readonly cell: Vec3; readonly stopped: string | null }
  | { readonly kind: "roof_provoked"; readonly targetId: number; readonly cell: Vec3; readonly plannedBlocks: number }
  | {
      readonly kind: "roof_engagement";
      readonly targetId: number;
      readonly cell: Vec3;
      readonly state: "waiting" | "hit" | "stopped";
      readonly confirmedHits: number;
      readonly noProgressTicks: number;
      readonly reason: string | null;
    }
  | {
      readonly kind: "cover_return";
      readonly targetId: number;
      readonly threatIds: readonly number[];
      readonly projectileIds: readonly number[];
      readonly targetWindingUp: boolean;
      readonly hurt: boolean;
      readonly canAttack: boolean;
      readonly failedPeeks: number;
    }
  | { readonly kind: "retarget"; readonly from: number; readonly to: number };

export type CombatOutcome =
  | CombatResult<"died">
  | CombatResult<"target_lost">
  | CombatResult<"cancelled">
  | CombatResult<"bot_died">
  | (CombatResult<"capability_blocked"> & {
      readonly reason: "building_materials" | "ranged_weapon" | "recovery" | "policy";
      readonly observation: string;
    })
  /** A different immediate danger must be handled before this target can be pursued. */
  | (CombatResult<"defence_required"> & { readonly observation: string })
  /** No route reached the target; the caller must decide, because retrying is being shot for nothing. */
  | (CombatResult<"unreachable"> & { readonly observation: string })
  | (CombatResult<"failed"> & { readonly observation: string });

export interface CombatResult<Kind extends string> {
  readonly kind: Kind;
  readonly targetId: number;
  readonly attacks: number;
  readonly stylesUsed: readonly CombatStyle[];
  readonly weaponsUsed: readonly string[];
  /** Exact-target swing animations seen while this controller had requested shield use. */
  readonly shieldRaisedSwings: number;
  /** Ranged windups by the target - bow draws, blaze charges - that this controller met with a raised shield. */
  readonly projectileGuards: number;
  /**
   * Explosions the server announced while this controller held the body. A
   * creeper that explodes is discarded rather than killed, so without this a
   * fuse that went off looks like a target that wandered away, and a blast
   * that killed the other creeper looks like a kill.
   */
  readonly explosions: number;
}

export type CombatEngagement = { readonly kind: "mob" | "end"; readonly targetId: number };

export interface CombatController {
  readonly policy: SurvivalPolicyState;
  resourceRefusal(target: Parameters<Bot["attack"]>[0], policy: Readonly<CombatPolicy>): string | null;
  runEnd(
    request:
      | { kind: "crystal"; targetId: number; observation: CrystalObservation }
      | { kind: "dragon_bow"; targetId: number; observation: DragonShotObservation }
      | { kind: "perch" | "prepare_perch"; targetId: number; observation: PerchObservation }
      | { kind: "evade" },
    signal: AbortSignal,
  ): Promise<EndCombatResult>;
  endDanger(): boolean;
  engage(targetId: number, signal: AbortSignal, movement: "pursue" | "hold"): Promise<CombatOutcome>;
  stop(reason: string): Promise<void>;
  /** The caller retains ownership until protection/separation succeeds or its physical limits are observed. */
  finish(signal: AbortSignal): Promise<CombatHandoff>;
  /**
   * Who owns combat, or null. Ordinary mob combat already handles nearby
   * hostiles; End mechanics must yield to the hostile reflex for that defense.
   */
  activeEngagement(): CombatEngagement | null;
  /** The current engagement can return to observed protection without giving up the body. */
  canRecover(): boolean;
  /** Current geometry for runtime diagnostics; presence alone does not assert current protection. */
  activePosition(): CombatPositionPlan | null;
  execution(): CombatExecutionSnapshot | null;
  onDecision(listener: (event: CombatDecision) => void): () => void;
}
