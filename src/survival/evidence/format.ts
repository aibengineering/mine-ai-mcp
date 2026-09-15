import type { Facts } from "../state/answered.js";
import type { SurvivalReceipt, SurvivalStatus } from "./contract.js";

function label(value: string): string {
  return value.replace(/_reflex$/, "").replaceAll("_", " ");
}

/** Routine replies show outcomes and actionable warnings; JSON retains the full snapshot. */
export function formatSurvivalStatus(status: SurvivalStatus): string {
  const lines = [`**Vitals:** Health ${status.vitals.health}/20; hunger ${status.vitals.food}/20.`];
  if (status.summary === "dead") lines.push("**Survival:** The bot died.");
  if (!status.owner.connected) {
    lines.push("**Warning:** Minecraft is disconnected; current safety cannot be assessed.");
    return lines.join("\n\n");
  }
  if (status.summary === "dead") return lines.join("\n\n");

  if (status.response) {
    lines.push(`**Survival:** Automatic ${label(status.response.capability)} response in progress (${label(status.response.kind)}).`);
  } else if (status.summary === "standing_down") {
    lines.push("**Survival:** The automatic response is standing down.");
  }
  for (const danger of status.dangers) {
    if (danger.unresolved) {
      lines.push(`**Warning:** Unresolved ${label(danger.reflex)} danger${danger.stale ? "; its last observation is stale" : ""}.`);
    }
  }
  if (status.summary === "standing_down") {
    for (const answer of status.answered) lines.push(`**Survival limitation:** ${answer.failure.why}`);
  }
  if (status.policy.constraint) lines.push(`**Survival limitation:** ${status.policy.constraint}`);

  // Missing oxygen is actionable in water, not a routine warning during work on land.
  for (const missing of status.observations.missing) {
    if (missing === "own_air_metadata") {
      if (status.vitals.inWater) {
        lines.push("**Warning:** The bot is in water, but its air supply is unavailable; the breath reflex cannot assess its remaining air.");
      }
    } else {
      lines.push(`**Warning:** A survival check is unavailable: ${label(missing)}.`);
    }
  }
  for (const stale of status.observations.stale) {
    if (stale === "breath_reflex" && !status.vitals.inWater) continue;
    lines.push(`**Warning:** The ${label(stale)} survival observation is stale.`);
  }
  return [...new Set(lines)].join("\n\n");
}

/** One outcome preview, with observed effects rather than internal phase chatter. */
export function formatSurvivalOutcome(receipt: SurvivalReceipt): string {
  const object = (value: Facts | undefined): Record<string, Facts> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Facts> : {};
  const evidence = object(receipt.evidence);
  const outcome = object(evidence.outcome);
  const interrupted = object(evidence.interrupted);
  const result = outcome.kind ?? outcome.outcome ?? evidence.kind ?? receipt.status.summary;
  const parts = [`${label(receipt.source)}: ${label(String(result))}`];
  if (typeof outcome.food === "string") parts.push(label(outcome.food));
  if (typeof interrupted.action === "string") parts.push(`interrupted ${interrupted.action}`);
  for (const [name, before, after] of [["health", outcome.healthBefore, outcome.healthAfter], ["hunger", outcome.hungerBefore, outcome.hungerAfter]] as const) {
    if (typeof before === "number" && typeof after === "number") parts.push(`${name} ${before} → ${after}/20`);
  }
  if (evidence.cancelled === true && result !== "cancelled") parts.push("cancelled");
  const error = outcome.error ?? evidence.why;
  if (typeof error === "string") parts.push(error);
  return parts.join("; ");
}
