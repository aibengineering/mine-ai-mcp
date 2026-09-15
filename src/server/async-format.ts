import type { Acceptance, AsyncActions, LiveProgress, WaitOutcome } from "../session/async-actions.js";
import type { CombatResources, Progress, ProgressPosition, ReflexState } from "../session/progress.js";
import type { BuildStructureRequest } from "../actions/build-structure/contract.js";
import type { RequestSnapshot } from "../session/request.js";

import { formatSurvivalStatus } from "../survival/evidence/format.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import { formatToolChange } from "../world/tool-tiers.js";

type ProtocolReply = (Acceptance | WaitOutcome | ReturnType<AsyncActions["cancel"]>) & {
  survival?: SurvivalStatus;
  vitalsDuringWait?: { healthBefore: number; healthAfter: number; foodBefore: number; foodAfter: number };
};

function number(value: number): string { return String(Math.round(value * 100) / 100); }
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${number(seconds % 60)}s`;
}
function text(value: string): string { return value.replace(/[\\`*_{}\[\]<>|]/g, "\\$&").replace(/\s+/g, " "); }
function label(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");
  return text(words.charAt(0).toUpperCase() + words.slice(1));
}
function position(value: ProgressPosition | null): string {
  return value ? `(${number(value.x)}, ${number(value.y)}, ${number(value.z)}) in ${text(value.dimension)}` : "unavailable";
}

function combatResources(resources: CombatResources): string | null {
  const durability = resources.durabilityUsed.map((entry) => `${text(entry.item)} slot ${entry.slot}: ${entry.before} → ${entry.now}`);
  const weapons = resources.weaponChanges.map((entry) => `${text(entry.from ?? "empty")} → ${text(entry.to ?? "empty")} (${text(entry.reason)})`);
  const parts = [
    ...(resources.arrowsFired ? [`Arrows fired: ${resources.arrowsFired}`] : []),
    ...(resources.arrowsRecovered ? [`arrows recovered: ${resources.arrowsRecovered}`] : []),
    ...(resources.shieldBlocks ? [`shield blocks: ${resources.shieldBlocks}`] : []),
    ...(resources.foodEaten ? [`food eaten: ${resources.foodEaten}`] : []),
    ...(resources.scaffoldPlaced ? [`scaffold placed: ${resources.scaffoldPlaced}`] : []),
    ...(durability.length ? [`durability used: ${durability.join(", ")}`] : []),
    ...(weapons.length ? [`weapon changes: ${weapons.join(", ")}`] : []),
  ];
  return parts.length ? parts.join("; ") + "." : null;
}

/** Policy-withheld responses are listed apart from other exclusions: only the former change by editing survival policy. */
function reflexActivity(states: readonly ReflexState[]): string | null {
  const count = (state: ReflexState) => `×${state.entries} (${duration(state.activeMs)})`;
  const reason = (state: ReflexState) => (state.detail === null ? "" : ` ${text(state.detail)}`);
  const responses = states.filter((state) => state.kind === "response").map((state) => `${text(state.reflex)} ${text(state.name)} ${count(state)}`);
  const policy = states.filter((state) => state.kind === "withheld" && state.exclusion === "prohibited")
    .map((state) => `${text(state.reflex)} ${text(state.name)} ${count(state)} by${reason(state)}`);
  const other = states.filter((state) => state.kind === "withheld" && state.exclusion !== "prohibited")
    .map((state) => `${text(state.reflex)} ${text(state.name)} ${count(state)} ${text((state.exclusion ?? "").replace(/_/g, " "))}${reason(state)}`);
  const phases = states.filter((state) => state.kind === "combat_phase").map((state) => `${text(state.name)} ${count(state)}`);
  const parts = [
    ...(responses.length ? [`responses: ${responses.join(", ")}`] : []),
    ...(policy.length ? [`withheld by policy: ${policy.join(", ")}`] : []),
    ...(other.length ? [`withheld otherwise: ${other.join(", ")}`] : []),
    ...(phases.length ? [`combat phases: ${phases.join(", ")}`] : []),
  ];
  return parts.length ? parts.join("; ") + "." : null;
}

/** A reminder of the live policy whenever combat, or a policy refusal, shaped the interval. A
 * forgotten override is visible here beside the reflex counts it caused; defaults are stated
 * so a withdrawal under defaults is not mistaken for one caused by an earlier edit. */
export function formatPolicyReminder(survival: SurvivalStatus | undefined, activity: readonly ReflexState[]): string | null {
  if (!survival) return null;
  const combat = activity.some((state) =>
    state.reflex === "hostile_reflex" || state.reflex === "dragon_reflex" || state.kind === "combat_phase" || state.exclusion === "prohibited");
  if (!combat) return null;
  const overrides = survival.policy.overrides.map((override) =>
    `${text(override.path)}=${text(Array.isArray(override.value) ? override.value.join("|") : String(override.value))}`);
  return `**Survival policy in effect:** ${overrides.length ? overrides.join(", ") : "defaults, no overrides"} (revision ${text(survival.policy.revision)}).`;
}

/** Render action-owned fields without assuming that attempts imply success. */
function facts(value: unknown, path = ""): string[] {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.length ? value.flatMap((item, index) => facts(item, `${path} ${index + 1}`)) : [`- **${path}:** none`];
    }
    const entries = Object.entries(value);
    if (!entries.length) return [`- **${path}:** none`];
    // Coordinates are easier to compare as one tuple than as three separate rows.
    if (entries.length === 3 && entries.every(([key, item]) => ["x", "y", "z"].includes(key) && typeof item === "number")) {
      const point = value as { x: number; y: number; z: number };
      return [`- **${path}:** (${number(point.x)}, ${number(point.y)}, ${number(point.z)})`];
    }
    return entries.flatMap(([key, item]) => facts(item, path ? `${path} / ${label(key)}` : label(key)));
  }
  const rendered = value == null ? "not recorded" : typeof value === "number" ? number(value)
    : typeof value === "boolean" ? (value ? "yes" : "no") : text(String(value));
  return [`- **${path}:** ${rendered}`];
}

function evidence(request: RequestSnapshot | null | undefined): string {
  if (!request) return "Action evidence unavailable.";
  const parts: string[] = [];
  if (request.state.kind === "suspended") parts.push(`**Suspended by:** ${text(request.state.by)}`);
  if (request.observationError) parts.push(`**Observation error:** ${text(request.observationError)}`);
  if (!request.evidence) return [...parts, "Action evidence unavailable."].join("\n\n");
  const { baseline, checkpoint, completion } = request.evidence;
  if (baseline !== null) parts.push(`**Starting evidence**\n\n${facts(baseline).join("\n")}`);
  parts.push(`**Action progress**\n\n${facts(checkpoint).join("\n")}`);
  const observation = completion.kind === "event" ? "Event observed" : "Currently satisfied";
  parts.push(`**Completion:** ${observation}: ${completion.observed ? "yes" : "no"}. ${text(completion.owes)}`);
  return parts.join("\n\n");
}

export function formatProgress(progress: Progress): string {
  const coverage = progress.movementCoverage;
  const combat = combatResources(progress.combatResources);
  const reflexes = reflexActivity(progress.reflexActivity);
  return [
    `**State:** ${progress.state} · **Elapsed:** ${duration(progress.elapsedMs)} · **Suspended:** ${duration(progress.suspendedMs)}`,
    `**Travel:** ${number(progress.distanceTravelledBlocks)} blocks, including ${number(progress.reflexDistanceBlocks)} during reflexes. **Distance from start:** ${progress.distanceFromStartBlocks === null ? "unavailable" : `${number(progress.distanceFromStartBlocks)} blocks`}.`,
    `**Start:** ${position(progress.start)}. **Current:** ${position(progress.current)}.`,
    `**Snapshot:** ${text(progress.sampledAt)}. **Position sample age:** ${progress.positionAgeMs === null ? "unavailable" : duration(progress.positionAgeMs)}.`,
    `**Movement coverage:** ${coverage.complete ? "complete" : "incomplete"}${coverage.discontinuities.length ? ` — ${coverage.discontinuities.map(label).join(", ")}` : ""}.`,
    ...(combat ? [`**Combat resources:** ${combat}`] : []),
    ...(reflexes ? [`**Reflexes:** ${reflexes}`] : []),
  ].join("\n\n");
}

export function formatFinalProgress(progress: Progress, request?: RequestSnapshot): string {
  return ["### Final progress", formatProgress(progress), evidence(request)].join("\n\n");
}

function objective(request: RequestSnapshot): string {
  if (request.action !== "build_structure") return facts(request.objective).join("\n");
  const { cells, removeWrongBlocks } = request.objective as BuildStructureRequest;
  const materials = new Map<string, number>();
  for (const cell of cells) materials.set(cell.blockName, (materials.get(cell.blockName) ?? 0) + 1);
  const bounds = (select: (...values: number[]) => number) =>
    ["x", "y", "z"].map((axis) => select(...cells.map((cell) => cell[axis as "x" | "y" | "z"]))).join(", ");
  return [`Build/audit ${cells.length} cells: ${[...materials].map(([name, count]) => `${count} ${text(name)}`).join(", ")}.`,
    ...(cells.length ? [`Bounds: (${bounds(Math.min)}) to (${bounds(Math.max)}).`] : []),
    `Replace wrong blocks: ${removeWrongBlocks ? "yes" : "no"}.`].join("\n");
}

function liveProgress(live: LiveProgress): string {
  return [`**Action:** ${text(live.action)}\n\nAction ID: ${text(live.actionId)}`,
    ...(live.request ? [`**Objective**\n\n${objective(live.request)}`] : []),
    formatProgress(live.progress), evidence(live.request)].join("\n\n");
}

export function formatForegroundStatus(status: ReturnType<AsyncActions["status"]>): string {
  const parts = ["### Foreground action", status.active ? liveProgress(status.active) : "No foreground action is running."];
  const unread = status.awaitingResult;
  if (unread) parts.push(`**Awaiting result retrieval:** ${text(unread.action)}.\n\nAction ID: ${text(unread.actionId)}\n\nCall wait_for_action to retrieve its full result before submitting another foreground action.`);
  if (status.storageError) parts.push(`**Storage error:** ${text(status.storageError)}`);
  return parts.join("\n\n");
}

export function formatProtocol(data: ProtocolReply): string {
  switch (data.state) {
    case "accepted":
      return `**Accepted:** ${text(data.action)}\n\nAction ID: ${text(data.actionId)}\n\nUse wait_for_action with this ID to inspect progress and obtain the final result.`;
    case "pending": {
      const wait = data.duringWait;
      const vitals = data.vitalsDuringWait;
      const changes = Object.entries(wait.checkpointDelta).map(([key, value]) => `- **${label(key)}:** ${value > 0 ? "+" : ""}${number(value)}`);
      const changedTools = wait.toolChanges.map((change) => `- **Tool:** ${text(formatToolChange(change))}`);
      const combat = combatResources(wait.combatResources);
      const reflexes = reflexActivity(wait.reflexActivity);
      const policyReminder = formatPolicyReminder(data.survival, wait.reflexActivity);
      return ["## Action in progress", liveProgress(data.progress),
        `**During this wait (${duration(wait.elapsedMs)}):** travelled ${number(wait.distanceTravelledBlocks)} blocks, including ${number(wait.reflexDistanceBlocks)} during reflexes; suspended for ${duration(wait.suspendedMs)}.`,
        ...(changes.length || changedTools.length ? [[...changes, ...changedTools].join("\n")] : []),
        ...(combat ? [`**Combat resources during this wait:** ${combat}`] : []),
        ...(reflexes ? [`**Reflexes during this wait:** ${reflexes}`] : []),
        ...(policyReminder ? [policyReminder] : []),
        ...(vitals && (vitals.healthBefore !== vitals.healthAfter || vitals.foodBefore !== vitals.foodAfter)
          ? [`**Vitals during this wait:** Health ${number(vitals.healthBefore)} → ${number(vitals.healthAfter)}/20; hunger ${number(vitals.foodBefore)} → ${number(vitals.foodAfter)}/20 (net changes).`] : []),
        ...(data.survival ? ["### Current survival", formatSurvivalStatus(data.survival)] : []),
        "Wait timed out; the action continues. Wait again, inspect status, or request cancellation."].join("\n\n");
    }
    case "refused":
      return [`**Refused (${text(data.code)}):** ${text(data.error)}`,
        ...(data.activeActionId ? [`Active action ID: ${text(data.activeActionId)}`] : []),
        ...(data.unretrievedActionId ? [`Unretrieved action ID: ${text(data.unretrievedActionId)}`] : [])].join("\n\n");
    case "cancellation_requested":
      return `**Cancellation requested**\n\nAction ID: ${text(data.actionId)}\n\n${text(data.cancellation.reason)}\n\nNecessary survival work may continue until safe release. Use wait_for_action to retrieve the final result.`;
    case "settled":
      return `**Action already settled**\n\nAction ID: ${text(data.actionId)}\n\nUse wait_for_action to retrieve the full result.`;
    case "storage_failed":
      return `**Result storage failed:** ${text(data.error)}\n\nAction ID: ${text(data.actionId)}`;
  }
}
