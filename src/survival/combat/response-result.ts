import type { HostileResponse } from "../policy/combat/response.js";
import type { CombatOutcome } from "./contract.js";
import type { DeflectResponseResult, EncounterEvidence, EvadeResponseResult, HideResponseResult } from "../responses/encounter.js";
export type FightResponseResult = EncounterEvidence & {
  readonly response: "fight";
  readonly result: CombatOutcome | { readonly kind: "contact_ended" };
};
export type HostileResponseResult =
  FightResponseResult | EvadeResponseResult | HideResponseResult | DeflectResponseResult;
export type HostileSettlement = {
  readonly response: HostileResponse["kind"];
  readonly evidence: EncounterEvidence;
  readonly physical: HostileResponseResult | null;
} & (
  | { readonly kind: "completed"; readonly physical: HostileResponseResult }
  | { readonly kind: "cancelled" | "bot_died" | "failed"; readonly reason: string }
);
