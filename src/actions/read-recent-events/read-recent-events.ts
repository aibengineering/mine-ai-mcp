import {
  allSqlQuery,
  botEventSchema,
  defineSqlQuery,
  getSqlQuery,
  type BotEvent,
  type SqlBotData,
} from "../../bot-data/index.js";
import { formatSurvivalStatus } from "../../survival/evidence/format.js";
import { markdownCodeBlock } from "../markdown.js";
import { defineSqlAction, sqlActionSource, type SqlAction } from "../sql-action.js";
import {
  parseReadRecentEventsRequest,
  readRecentEventsAnnotations,
  readRecentEventsInputSchema,
  READ_RECENT_EVENTS,
  READ_RECENT_EVENTS_DESCRIPTION,
  readRecentEventsResultSchema,
  type ReadRecentEventsRequest,
  type ReadRecentEventsResult,
} from "./contract.js";

export const eventCursorQuery = defineSqlQuery({
  id: "event-read-cursor",
  produces: "The event id through which one bot has already read.",
  parameterNames: ["botId"] as const,
  sql: "SELECT read_through_event_id FROM main.event_read_state WHERE bot_id = ?",
  parseRow: (row) => Number(row.read_through_event_id),
});

export const unreadEventsPageQuery = defineSqlQuery({
  id: "unread-events-page",
  produces: "One oldest-first page of events after a bot's current read cursor.",
  parameterNames: ["botId", "readThroughEventId", "limit"] as const,
  sql: `
    SELECT event_id, bot_id, event_type, observed_at, summary, payload_json
    FROM main.events
    WHERE bot_id = ? AND event_id > ?
    ORDER BY event_id
    LIMIT ?
  `,
  parseRow: (row) => {
    const payload: unknown = JSON.parse(String(row.payload_json));
    return botEventSchema.parse({
      eventId: row.event_id,
      botId: row.bot_id,
      type: row.event_type,
      observedAt: row.observed_at,
      summary: row.summary,
      // Encounters recorded before explosions were counted read back as none.
      payload:
        row.event_type === "hostile_encounter"
          ? { explosions: 0, ...(payload as object) }
          : row.event_type === "player_death"
            ? { cause: null, ...(payload as object) }
            : payload,
    });
  },
});

export const remainingEventsQuery = defineSqlQuery({
  id: "remaining-events-count",
  produces: "The number of events remaining after one bot's supplied event cursor.",
  parameterNames: ["botId", "readThroughEventId"] as const,
  sql: "SELECT count(*) AS count FROM main.events WHERE bot_id = ? AND event_id > ?",
  parseRow: (row) => Number(row.count),
});

const READ_RECENT_EVENTS_QUERIES = [eventCursorQuery, unreadEventsPageQuery, remainingEventsQuery] as const;

export interface ReadEventsPage {
  readonly events: BotEvent[];
  readonly readThroughEventId: number;
  readonly remainingEventCount: number;
}

/** Return the oldest unread events and atomically advance this bot's cursor through them. */
export function readRecentEvents(data: SqlBotData, botId: string, limit: number): ReadEventsPage {
  if (botId.trim().length === 0) throw new TypeError("Event botId must not be empty.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Event limit must be an integer from 1 to 100.");
  }

  return data.transaction((database) => {
    const readThrough = getSqlQuery(database, eventCursorQuery.bind({ botId })) ?? 0;
    const events = allSqlQuery(database, unreadEventsPageQuery.bind({ botId, readThroughEventId: readThrough, limit }));
    const readThroughEventId = events.at(-1)?.eventId ?? readThrough;

    if (readThroughEventId > readThrough) {
      database
        .prepare(
          `INSERT INTO event_read_state (bot_id, read_through_event_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (bot_id) DO UPDATE SET
             read_through_event_id = max(event_read_state.read_through_event_id, excluded.read_through_event_id),
             updated_at = excluded.updated_at`,
        )
        .run(botId, readThroughEventId, new Date().toISOString());
    }

    const remainingEventCount = allSqlQuery(database, remainingEventsQuery.bind({ botId, readThroughEventId }))[0];
    return { events, readThroughEventId, remainingEventCount };
  }, { name: "readRecentEvents" });
}

/** Read and advance through one oldest-first page of this bot's event stream. */
export function readRecentBotEvents(
  data: SqlBotData,
  botId: string,
  request: ReadRecentEventsRequest,
): ReadRecentEventsResult {
  return {
    status: "succeeded",
    ...readRecentEvents(data, botId, request.limit),
    source: sqlActionSource(READ_RECENT_EVENTS_QUERIES),
  };
}

export function formatReadRecentEventsResult(result: ReadRecentEventsResult): string {
  const sections = result.events.map(formatEvent);
  if (sections.length === 0) sections.push("No unread events were waiting.");
  sections.push(
    `**Remaining events:** ${result.remainingEventCount}`,
    `**Read through event:** ${result.readThroughEventId}`,
  );
  if (result.status !== "succeeded") sections.push(`**Observed stop:** ${result.error}`);
  return sections.join("\n\n");
}

function formatEvent(event: BotEvent): string {
  switch (event.type) {
    case "equipment_low_durability":
    case "equipment_broken":
      return `### Event ${event.eventId}: equipment\n- Observed: ${event.observedAt}\n- ${event.summary}\n- Location: ${event.payload.location}`;
    case "survival_danger":
    case "survival_decision":
    case "survival_claim":
    case "survival_phase":
    case "survival_outcome": {
      const { source, kind, evidence, status } = event.payload;
      return [
        `### Event ${event.eventId}: ${source} ${kind}`,
        formatSurvivalStatus(status),
        `- Evidence: ${JSON.stringify(evidence)}`,
      ].join("\n");
    }
    case "combat_engagement": {
      const { execution, state, targetId, targetDistance, bodyOwner, outcome, observation } = event.payload;
      return [
        `### Event ${event.eventId}: combat ${state}`,
        `- Engagement: ${execution.progress.engagementId}`,
        `- Target: ${targetId}; distance: ${targetDistance?.toFixed(1) ?? "unobserved"}`,
        `- Body owner: ${bodyOwner}; phase: ${execution.phase}`,
        `- Awaiting: ${execution.expected}`,
        `- Without objective progress: ${Math.round(execution.progress.inactiveMs)} ms`,
        `- Attack attempts: ${execution.attacks}; confirmed target hits: ${execution.progress.confirmedTargetHits}`,
        `- Defensive hits: ${execution.progress.confirmedDefensiveHits}; completed volleys: ${execution.progress.completedVolleys}`,
        ...(outcome ? [`- Outcome: ${outcome}`] : []),
        ...(observation ? [`- Observation: ${observation}`] : []),
      ].join("\n");
    }
    case "combat_policy":
      return `### Event ${event.eventId}: combat policy (historical)
${event.summary}
Revision: ${event.payload.revision}
${JSON.stringify(event.payload.override)}
Constraint: ${event.payload.constraint ?? "none"}`;
    case "survival_policy":
      return `### Event ${event.eventId}: survival policy
${event.summary}
Revision: ${event.payload.revision}
Overrides: ${JSON.stringify(event.payload.overrides)}
Constraint: ${event.payload.constraint ?? "none"}`;
    case "dragon_reflex":
      return `### Event ${event.eventId}: dragon escape\n- Observed: ${event.observedAt}\n- Outcome: ${event.payload.outcome}\n- Health: ${event.payload.healthBefore} → ${event.payload.healthAfter}\n- Interrupted: ${event.payload.interrupted?.action ?? "nothing; the bot was idle"}\n- Reason: ${event.payload.reason ?? "clear of the observed hazard"}`;
    case "stronghold_located":
      return `### Event ${event.eventId}: stronghold located\n- Observed: ${event.observedAt}\n- Search: ${event.payload.searchId}\n- Dimension: ${event.payload.dimension}\n- Portal frame: ${event.payload.confirmation.position.x}, ${event.payload.confirmation.position.y}, ${event.payload.confirmation.position.z}\n- Saved throws: ${event.payload.throwIds.join(", ") || "none; frame already loaded"}`;
    case "fire_reflex":
      return `### Event ${event.eventId}: fire escape\n- Observed: ${event.observedAt}\n- Outcome: ${event.payload.outcome}\n- Health: ${event.payload.healthBefore} → ${event.payload.healthAfter}\n- Interrupted: ${event.payload.interrupted?.action ?? "nothing; the bot was idle"}`;
    case "player_message":
      return [
        `### Event ${event.eventId}: player message`,
        `- Observed: ${event.observedAt}`,
        `- From: \`${event.payload.username}\``,
        `- Channel: ${event.payload.channel}`,
        `- Direction: ${event.payload.direction}`,
        `- Addressed to bot: ${event.payload.addressed}`,
        "- Message:",
        markdownCodeBlock(event.payload.message),
      ].join("\n");
    case "player_death":
      return [
        `### Event ${event.eventId}: player death`,
        `- Observed: ${event.observedAt}`,
        `- Dimension: \`${event.payload.dimension}\``,
        `- Position: \`${event.payload.position.x}, ${event.payload.position.y}, ${event.payload.position.z}\``,
        `- Cause: ${event.payload.cause ?? "not reported"}`,
      ].join("\n");
    case "player_dimension_change":
      return [
        `### Event ${event.eventId}: dimension change`,
        `- Observed: ${event.observedAt}`,
        `- From: \`${event.payload.from}\``,
        `- To: \`${event.payload.to}\``,
        `- Arrived at: \`${event.payload.position.x}, ${event.payload.position.y}, ${event.payload.position.z}\``,
      ].join("\n");
    case "hostile_encounter":
      return [
        `### Event ${event.eventId}: hostile encounter`,
        `- Observed: ${event.observedAt}`,
        `- Response: ${event.payload.response}`,
        `- Outcome: ${event.payload.outcome}`,
        `- Interrupted: ${event.payload.interrupted ? `\`${event.payload.interrupted.action}\`` : "nothing; the bot was idle"}`,
        `- Health: ${event.payload.healthBefore} → ${event.payload.healthAfter}`,
        `- Threats: ${event.payload.threats.map((threat) => `\`${threat.name}#${threat.id}\``).join(", ")}`,
        `- Killed target ids: ${event.payload.killedTargetIds.join(", ") || "none"}`,
        `- Attacks: ${event.payload.attacks}`,
        `- Combat styles: ${event.payload.combatStyles.join(" → ") || "none"}`,
        `- Weapons used: ${event.payload.weaponsUsed.join(" → ") || "none"}`,
        `- Target swings while shield was raised: ${event.payload.shieldRaisedSwings}`,
        `- Bow draws met with a raised shield: ${event.payload.projectileGuards}`,
        `- Explosions: ${event.payload.explosions}`,
        ...(event.payload.hide
          ? [
              `- Hide: dug ${event.payload.hide.dug} down${event.payload.hide.walled > 0 ? `, walled in with ${event.payload.hide.walled} blocks` : ""}, ${event.payload.hide.capped ? "capped the hole" : "left it open"}${event.payload.hide.ate ? `, ate ${event.payload.hide.ate}` : ""}${event.payload.hide.swings > 0 ? `, ${event.payload.hide.swings} swings at what fell in` : ""}; hunger after ${event.payload.hide.hungerAfter}`,
            ]
          : []),
        `- Bot ended at: ${event.payload.finalPosition.x.toFixed(1)}, ${event.payload.finalPosition.y.toFixed(1)}, ${event.payload.finalPosition.z.toFixed(1)}`,
        `- Reason: ${event.payload.reason}`,
      ].join("\n");
    case "hunger_reflex":
      return [
        `### Event ${event.eventId}: ate without being asked`,
        `- Observed: ${event.observedAt}`,
        `- Food: ${event.payload.food}${event.payload.consumed ? "" : " (not consumed)"}`,
        `- Hunger: ${event.payload.hungerBefore} → ${event.payload.hungerAfter}; saturation ${event.payload.saturationBefore.toFixed(1)} → ${event.payload.saturationAfter.toFixed(1)}`,
        `- Interrupted: ${event.payload.interrupted ? `\`${event.payload.interrupted.action}\`, resumed afterwards` : "nothing; the bot was idle"}`,
        ...(event.payload.error ? [`- Error: ${event.payload.error}`] : []),
      ].join("\n");
    case "breath_reflex":
      return [
        `### Event ${event.eventId}: surfacing attempt`,
        `- Observed: ${event.observedAt}`,
        `- Outcome: ${event.summary}`,
        `- Air: ${event.payload.airBefore} → ${event.payload.airAfter} of 20; health ${event.payload.healthBefore.toFixed(1)} → ${event.payload.healthAfter.toFixed(1)}`,
        ...(event.payload.dug > 0 ? [`- Dug through ${event.payload.dug} roof block(s) on the way up`] : []),
        `- Interrupted: ${event.payload.interrupted ? `\`${event.payload.interrupted.action}\`` : "nothing; the bot was idle"}`,
      ].join("\n");
  }
}

/** Bind one bot's durable event cursor into the generic action contract. */
export function createReadRecentEventsAction(
  data: SqlBotData,
  botId: string,
): SqlAction<typeof READ_RECENT_EVENTS, ReadRecentEventsRequest, ReadRecentEventsResult> {
  return defineSqlAction({
    name: READ_RECENT_EVENTS,
    description: READ_RECENT_EVENTS_DESCRIPTION,
    inputSchema: readRecentEventsInputSchema,
    resultSchema: readRecentEventsResultSchema,
    queries: READ_RECENT_EVENTS_QUERIES,
    formatResult: formatReadRecentEventsResult,
    // Reading events needs no body: the ninth playthrough asked what was
    // happening while the reflex fought and was refused for being busy.
    execution: { kind: "information" },
    annotations: readRecentEventsAnnotations,
    parse: parseReadRecentEventsRequest,
    execute: async (request) => readRecentBotEvents(data, botId, request),
  });
}
