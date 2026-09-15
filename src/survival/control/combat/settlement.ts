import type { Continuation } from "../../../session/abort.js";
import type { AnsweredEntry, Facts } from "../../state/answered.js";
import type { HostileResponseResult, HostileSettlement } from "./response-result.js";

export function completeResponse(physical: HostileResponseResult, signal: AbortSignal): HostileSettlement {
  const { result: _result, response, ...evidence } = physical;
  const common = { response, physical, evidence };
  return signal.aborted
    ? {
        ...common,
        kind: "cancelled",
        reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
      }
    : { ...common, kind: "completed" };
}

function responseSummary(physical: HostileResponseResult): { outcome: string; error: string | null } {
  switch (physical.response) {
    case "evade":
      return physical.result.kind === "separated"
        ? { outcome: "safe_separation", error: null }
        : { outcome: physical.result.kind === "failed" ? "failed" : "capability_limit", error: physical.result.reason };
    case "deflect":
      return {
        outcome: physical.result.kind === "reflected" ? "projectile_reflected" : "capability_limit",
        error: physical.result.kind === "reflected" ? null : physical.result.observation,
      };
    case "hide":
      return {
        outcome: physical.result.kind === "failed" ? "capability_limit" : "hidden",
        error:
          physical.result.kind === "recovered"
            ? null
            : physical.result.kind === "held"
              ? `Hidden, but health is still ${physical.healthAfter}: ${physical.result.error}.`
              : `Emergency hide failed: ${physical.result.error}.`,
      };
    case "fight": {
      const result = physical.result;
      switch (result.kind) {
        case "died":
          return { outcome: "target_died", error: null };
        case "contact_ended":
          return { outcome: "contact_ended", error: null };
        case "target_lost":
          return { outcome: "target_lost", error: `Target ${result.targetId} disappeared without an observed death.` };
        case "unreachable":
          return { outcome: "target_unreachable", error: result.observation };
        case "capability_blocked":
          return { outcome: "capability_limit", error: `${result.reason}: ${result.observation}` };
        case "defence_required":
          return { outcome: "disengaged", error: result.observation };
        case "failed":
          return { outcome: "failed", error: result.observation };
        case "bot_died":
          return { outcome: "bot_died", error: "The bot died during combat." };
        case "cancelled":
          return { outcome: "cancelled", error: "Combat stopped after a policy change." };
      }
    }
  }
}

/** Only the receipt boundary flattens response-specific results into operator vocabulary. */
export function encounterReceipt(settlement: HostileSettlement) {
  const summary =
    settlement.kind === "completed"
      ? responseSummary(settlement.physical)
      : { outcome: settlement.kind, error: settlement.reason };
  return {
    ...settlement.evidence,
    response: settlement.response,
    outcome: summary.outcome,
    ...(summary.error === null ? {} : { error: summary.error }),
    hide: settlement.physical?.response === "hide" ? settlement.physical.result : null,
  };
}

export function responseContinuation(settlement: HostileSettlement): Continuation {
  // A completed physical response returns the request to current-condition
  // validation. Historical blasts do not invalidate every future route.
  if (settlement.kind === "completed" && settlement.evidence.healthAfter > 0) {
    const physical = settlement.physical;
    const resume =
      physical.response === "fight"
        ? ["died", "target_lost", "unreachable", "contact_ended"].includes(physical.result.kind)
        : physical.response === "hide"
          ? physical.result.kind === "recovered"
          : physical.response === "evade"
            ? physical.result.kind === "separated"
            : physical.result.kind === "reflected";
    if (resume) return { kind: "resume" };
  }
  const receipt = encounterReceipt(settlement);
  return {
    kind: "return",
    reason: `[HOSTILE_SETTLED] ${receipt.response} ended with ${receipt.outcome} at health ${receipt.healthAfter}: ${receipt.error ?? receipt.reason}.`,
  };
}

export function responseFailure(settlement: HostileSettlement): AnsweredEntry["failure"] | null {
  if (settlement.kind !== "completed")
    return settlement.kind === "failed" ? { kind: "failed", why: settlement.reason } : null;
  const physical = settlement.physical;
  switch (physical.response) {
    case "fight": {
      const result = physical.result;
      if (["died", "contact_ended", "cancelled", "bot_died"].includes(result.kind)) return null;
      return {
        kind: result.kind,
        why: "observation" in result ? result.observation : "The target left observation without a death.",
      };
    }
    case "hide":
      return physical.result.kind === "failed"
        ? { kind: "enclosure_failed", why: physical.result.error ?? "The enclosure could not be completed." }
        : null;
    case "evade":
      return physical.result.kind === "separated" ? null : { kind: physical.result.kind, why: physical.result.reason };
    case "deflect":
      return physical.result.kind === "reflected"
        ? null
        : { kind: "deflection_unobserved", why: physical.result.observation };
  }
}

export function describeResponse(settlement: HostileSettlement): Facts {
  const receipt = encounterReceipt(settlement);
  return {
    ...receipt,
    error: receipt.error ?? null,
    threats: receipt.threats.map((threat) => ({ ...threat, position: { ...threat.position } })),
    finalPosition: { ...receipt.finalPosition },
    finalDistances: receipt.finalDistances.map((entry) => ({ ...entry })),
    hide: receipt.hide ? { ...receipt.hide, error: receipt.hide.error ?? null } : null,
    physical: settlement.physical
      ? {
          response: settlement.physical.response,
          result:
            settlement.physical.response === "hide"
              ? { ...settlement.physical.result, error: settlement.physical.result.error ?? null }
              : { ...settlement.physical.result },
        }
      : null,
  };
}
