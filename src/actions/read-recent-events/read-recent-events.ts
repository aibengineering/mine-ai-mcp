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
  parseRow: (row) =>
    botEventSchema.parse({
      eventId: row.event_id,
      botId: row.bot_id,
      type: row.event_type,
      observedAt: row.observed_at,
      summary: row.summary,
      payload: JSON.parse(String(row.payload_json)),
    }),
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
    case "stronghold_located":
      return `### Event ${event.eventId}: stronghold located\n- Observed: ${event.observedAt}\n- Search: ${event.payload.searchId}\n- Dimension: ${event.payload.dimension}\n- Portal frame: ${event.payload.confirmation.position.x}, ${event.payload.confirmation.position.y}, ${event.payload.confirmation.position.z}\n- Saved throws: ${event.payload.throwIds.join(", ") || "none; frame already loaded"}`;
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
