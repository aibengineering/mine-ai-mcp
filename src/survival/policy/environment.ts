import { REGENERATION_HUNGER } from "../../world/food.js";
import type { ResponseDecision } from "../control/contract.js";
import type { FireEscapeReason } from "../positioning/fire-escape.js";
export interface FireFacts {
  readonly reason: FireEscapeReason;
  readonly advancing: boolean;
  readonly inLava: boolean;
  readonly inFire: boolean;
  readonly burning: boolean;
  readonly escapeAvailable: boolean;
}

export function decideFireResponse(facts: FireFacts): ResponseDecision<FireEscapeReason> {
  if (!facts.advancing && !facts.inLava && !facts.inFire && !facts.escapeAvailable)
    return {
      kind: "stand_down",
      candidates: [
        {
          response: "escape_fire",
          excluded: {
            kind: "infeasible_now",
            premise: "No reachable water; the body is outside active fire and lava.",
          },
        },
      ],
    };
  return {
    kind: "respond",
    response: facts.reason,
    name: "escape_fire",
    reason: `[FIRE] ${facts.reason}: leave the active fire source or extinguish residual burning`,
  };
}
/**
 * Surface when air falls to this, of twenty. Each point is fifteen ticks, so
 * twelve points leave nine seconds before the air runs out.
 */
export const BREATH_SURFACE_AIR = 12;

/**
 * With a roof over the head the dig starts almost at once: under water a
 * stone block takes a stone pickaxe nearly six seconds, and a sealed chamber
 * dug through at half air cost the fixture bot twelve health.
 */
export const BREATH_ROOF_AIR = 18;

/** Give up the claim after this long and let the action have the body back. */
export const SURFACE_MAXIMUM_TICKS = 600;
/**
 * Ordinary eating leaves room for a filling meal. A wounded bot also eats
 * when its hunger is below the eighteen required for natural regeneration.
 */
export const HUNGER_EAT_THRESHOLD = 14;

export function needsBreathResponse(air: number, roof: string | null): boolean {
  return air <= (roof === null ? BREATH_SURFACE_AIR : BREATH_ROOF_AIR);
}

export interface SurfaceResponse {
  readonly airBefore: number;
  readonly maximumTicks: number;
}

export function decideBreathResponse(air: number): ResponseDecision<SurfaceResponse> {
  return {
    kind: "respond",
    response: { airBefore: air, maximumTicks: SURFACE_MAXIMUM_TICKS },
    name: "surface",
    reason: `[BREATH] surface at air ${air}.`,
  };
}

export function needsFood(health: number, hunger: number): boolean {
  return hunger <= HUNGER_EAT_THRESHOLD || (health < 20 && hunger < REGENERATION_HUNGER);
}

export interface HungerFacts {
  readonly food: number;
  readonly health: number;
  readonly combatActive: boolean;
  readonly bodyBusy: boolean;
  /** No meal is selected while another response owns the body. */
  readonly selectedFood: string | null;
  /** Uncooked food the raw_food policy held back, when it was the only meal. */
  readonly withheldRaw: string | null;
  /** The policy's own words for why, so the model can read them from the decision. */
  readonly rawFoodRule: string | null;
}

export function decideHungerResponse(facts: HungerFacts): ResponseDecision<string> {
  if (facts.combatActive) return { kind: "handled", by: "combat" };
  if (facts.bodyBusy) return { kind: "handled", by: "survival_response" };
  if (facts.selectedFood === null && facts.withheldRaw !== null)
    return {
      kind: "stand_down",
      candidates: [
        {
          response: "eat",
          excluded: {
            kind: "infeasible_now",
            premise: `Only uncooked ${facts.withheldRaw} is carried and ${facts.rawFoodRule ?? "policy holds it back"}.`,
          },
        },
      ],
    };
  if (facts.selectedFood === null)
    return {
      kind: "stand_down",
      candidates: [{ response: "eat", excluded: { kind: "missing_equipment", item: "food" } }],
    };
  return {
    kind: "respond",
    response: facts.selectedFood,
    name: "eat",
    reason: `[HUNGER] eat ${facts.selectedFood} at hunger ${facts.food}.`,
  };
}

export function decideFootingResponse(facts: { readonly combatActive: boolean; readonly bucketNeeded?: boolean }): ResponseDecision<"recover_footing"> {
  return facts.combatActive && !facts.bucketNeeded
    ? { kind: "handled", by: "combat" }
    : {
        kind: "respond",
        response: "recover_footing",
        name: "recover_footing",
        reason: facts.bucketNeeded ? "A damaging fall needs immediate water placement" : "External impulse threatens footing",
      };
}
