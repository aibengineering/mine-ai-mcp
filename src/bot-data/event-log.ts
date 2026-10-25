import { z } from "zod";
import { survivalReceiptSchema } from "../survival/evidence/contract.js";
import type { SqlBotData } from "./sql-bot-data.js";

const survivalEventInputSchema = z.strictObject({
  type: z.enum(["survival_danger", "survival_decision", "survival_claim", "survival_phase", "survival_outcome"]),
  observedAt: z.string(),
  summary: z.string(),
  payload: survivalReceiptSchema,
});

export const NOTIFICATION_HINT = "Use read_recent_events to read and advance through recent events.";

const playerMessagePayloadSchema = z.strictObject({
  username: z.string().min(1),
  channel: z.enum(["chat", "whisper"]),
  direction: z.enum(["incoming", "outgoing"]),
  message: z.string(),
  addressed: z.boolean(),
});

const playerMessageEventInputSchema = z.strictObject({
  type: z.literal("player_message"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: playerMessagePayloadSchema,
});

const playerDeathPayloadSchema = z.strictObject({
  dimension: z.string().min(1),
  position: z.strictObject({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  /** The server's own account of what killed the bot, as the chat line reads; null when none arrived. */
  cause: z.string().nullable(),
});

const playerDeathEventInputSchema = z.strictObject({
  type: z.literal("player_death"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: playerDeathPayloadSchema,
});

const playerDimensionChangePayloadSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  position: z.strictObject({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
});

/** The bot arrived in another dimension, through a portal or by being moved there. */
const playerDimensionChangeEventInputSchema = z.strictObject({
  type: z.literal("player_dimension_change"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: playerDimensionChangePayloadSchema,
});

const strongholdLocatedEventInputSchema = z.strictObject({
  type: z.literal("stronghold_located"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: z.strictObject({
    searchId: z.string(),
    dimension: z.string(),
    throwIds: z.array(z.string()),
    estimate: z.strictObject({ x: z.number().finite(), z: z.number().finite() }).nullable(),
    confirmation: z.strictObject({
      block: z.literal("end_portal_frame"),
      position: z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
    }),
  }),
});

const equipmentEventInputSchema = z.strictObject({
  type: z.enum(["equipment_low_durability", "equipment_broken"]),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: z.strictObject({
    item: z.string().nullable(),
    slot: z.number().int().nonnegative(),
    location: z.enum(["main_hand", "off_hand", "head", "chest", "legs", "feet", "inventory"]),
    remaining: z.number().int().nonnegative().nullable(),
    maximum: z.number().int().positive().nullable(),
  }),
});

export const botEventInputSchema = z.discriminatedUnion("type", [
  equipmentEventInputSchema,
  survivalEventInputSchema,
  strongholdLocatedEventInputSchema,
  playerMessageEventInputSchema,
  playerDeathEventInputSchema,
  playerDimensionChangeEventInputSchema,
]);
export type BotEventInput = z.output<typeof botEventInputSchema>;

const storedEventFields = { eventId: z.number().int().positive(), botId: z.string().min(1) };

/**
 * An event as read back: exactly what `recordEvent` accepts, plus its id and
 * owner. Event types that are no longer written are not readable either; a
 * store written before they were retired carries an older schema version and
 * is refused when it opens (see `SQL_BOT_DATA_SCHEMA_VERSION`).
 */
export const botEventSchema = z.discriminatedUnion("type", [
  equipmentEventInputSchema.extend(storedEventFields),
  survivalEventInputSchema.extend(storedEventFields),
  strongholdLocatedEventInputSchema.extend(storedEventFields),
  playerMessageEventInputSchema.extend(storedEventFields),
  playerDeathEventInputSchema.extend(storedEventFields),
  playerDimensionChangeEventInputSchema.extend(storedEventFields),
]);
export type BotEvent = z.output<typeof botEventSchema>;

export const notificationSummarySchema = z.strictObject({
  unreadCount: z.number().int().nonnegative(),
  recentPreview: z.array(z.string()).max(3).optional(),
  hint: z.string().optional(),
});
export type NotificationSummary = z.output<typeof notificationSummarySchema>;

/** Append one typed observation to the durable event chronology. */
export function recordEvent(data: SqlBotData, botId: string, input: BotEventInput): BotEvent {
  const owner = eventBotId(botId);
  const event = botEventInputSchema.parse(input);
  return data.transaction((database) => {
    if (event.type === "player_death") {
      database.prepare(
        `INSERT OR REPLACE INTO bot_last_death (bot_id, dimension, x, y, z, observed_at, cause)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        owner,
        event.payload.dimension,
        event.payload.position.x,
        event.payload.position.y,
        event.payload.position.z,
        event.observedAt,
        event.payload.cause,
      );
    }
    const inserted = database
      .prepare(
        `INSERT INTO events (bot_id, event_type, observed_at, summary, payload_json)
         VALUES (?, ?, ?, ?, ?)
         RETURNING event_id`,
      )
      .get(owner, event.type, event.observedAt, event.summary, JSON.stringify(event.payload)) as {
      event_id: number;
    };
    return botEventSchema.parse({ ...event, eventId: inserted.event_id, botId: owner });
  }, { name: "recordEvent" });
}

/** Read the compact notice selected by notification policy without advancing the event cursor. */
export function readNotificationSummary(data: SqlBotData, botId: string): NotificationSummary {
  const owner = eventBotId(botId);
  const unread = data.read(
    `WITH unread AS (
       SELECT event_id, event_type, summary
       FROM events
       WHERE bot_id = ?
         AND event_id > COALESCE(
           (SELECT read_through_event_id FROM event_read_state WHERE bot_id = ?),
           0
         )
         AND (
           event_type <> 'player_message'
           OR json_extract(payload_json, '$.direction') = 'incoming'
         )
     )
     SELECT event_id, event_type, summary, count(*) OVER () AS unread_count
     FROM unread
     ORDER BY event_id DESC
     LIMIT 3`,
    owner,
    owner,
  );
  if (unread.length === 0) return { unreadCount: 0 };
  return {
    unreadCount: Number(unread[0]?.unread_count),
    recentPreview: unread
      .reverse()
      .map((row) => {
        const summary = String(row.summary);
        // Reflex previews need enough room for the interruption and observed vitals.
        const limit = row.event_type === "survival_outcome" ? 200 : 40;
        return summary.length <= limit ? summary : `${summary.slice(0, limit)}...`;
      }),
    hint: NOTIFICATION_HINT,
  };
}

function eventBotId(botId: string): string {
  if (botId.trim().length === 0) throw new TypeError("Event botId must not be empty.");
  return botId;
}
