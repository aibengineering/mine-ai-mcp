import { z } from "zod";
import { combatExecutionSnapshotSchema } from "../survival/control/combat/execution.js";
import { survivalReceiptSchema } from "../survival/evidence/contract.js";
import { changesSchema, policyLifetimeSchema, policySnapshotSchema } from "../survival/policy/contract.js";
import { combatPolicySchema } from "../survival/policy/combat/contract.js";
import type { SqlBotData } from "./sql-bot-data.js";

const survivalEventInputSchema = z.strictObject({
  type: z.enum(["survival_danger", "survival_decision", "survival_claim", "survival_phase", "survival_outcome"]),
  observedAt: z.string(),
  summary: z.string(),
  payload: survivalReceiptSchema,
});

const combatEngagementEventInputSchema = z.strictObject({
  type: z.literal("combat_engagement"),
  observedAt: z.string(),
  summary: z.string(),
  payload: z.strictObject({
    state: z.enum(["started", "waiting", "stall", "resumed", "ended"]),
    requestId: z.number().nullable(),
    targetId: z.number(),
    targetDistance: z.number().nullable(),
    bodyOwner: z.string(),
    outcome: z.string().nullable(),
    /** Older persisted engagements did not retain the final observation. */
    observation: z.string().nullable().optional(),
    execution: combatExecutionSnapshotSchema,
  }),
});

export const NOTIFICATION_HINT = "Use read_recent_events to read and advance through recent events.";

const survivalPolicyEventInputSchema = z.strictObject({
  type: z.literal("survival_policy"),
  observedAt: z.string(),
  summary: z.string(),
  payload: policySnapshotSchema,
});

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

const hostileEncounterPayloadSchema = z.strictObject({
  response: z.enum(["fight", "evade", "hide", "deflect"]),
  outcome: z.enum([
    "projectile_reflected",
    "target_died",
    "safe_separation",
    "contact_ended",
    "hidden",
    "target_lost",
    "target_unreachable",
    "disengaged",
    "bot_died",
    "capability_limit",
    "standing_down",
    "failed",
    "cancelled",
  ]),
  reason: z.string(),
  // Null when the reflex claimed an idle body: nothing was interrupted.
  interrupted: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
  /** Session preference at settlement; older stored events predate withdrawal intent. */
  policyRevision: z.string().optional(),
  /** Historical receipts retain their original intent; live policy never reads this field. */
  combatIntent: z.enum(["auto", "withdraw"]).optional(),
  threats: z.array(z.strictObject({ id: z.number().int(), name: z.string() })),
  healthBefore: z.number(),
  healthAfter: z.number(),
  killedTargetIds: z.array(z.number().int()),
  attacks: z.number().int().nonnegative(),
  combatStyles: z.array(z.enum(["bow", "shielded_melee", "melee"])),
  weaponsUsed: z.array(z.string().min(1)),
  shieldRaisedSwings: z.number().int().nonnegative(),
  projectileGuards: z.number().int().nonnegative(),
  explosions: z.number().int().nonnegative(),
  /** What the emergency hide did, when the response was to hide. */
  hide: z
    .strictObject({
      dug: z.number().int().nonnegative(),
      walled: z.number().int().nonnegative(),
      capped: z.boolean(),
      /** The bot was already sealed in, so nothing dug and nothing placed is the box working. */
      enclosed: z.boolean(),
      ate: z.string().nullable(),
      swings: z.number().int().nonnegative(),
      hungerAfter: z.number(),
    })
    .optional(),
  finalPosition: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  finalDistances: z.array(z.strictObject({ id: z.number().int(), distance: z.number().nonnegative() })),
});

const hostileEncounterEventInputSchema = z.strictObject({
  type: z.literal("hostile_encounter"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: hostileEncounterPayloadSchema,
});

const hungerReflexPayloadSchema = z.strictObject({
  food: z.string().min(1),
  consumed: z.boolean(),
  hungerBefore: z.number(),
  hungerAfter: z.number(),
  saturationBefore: z.number(),
  saturationAfter: z.number(),
  // Null when the reflex claimed an idle body: nothing was interrupted.
  interrupted: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
  error: z.string().optional(),
});

const hungerReflexEventInputSchema = z.strictObject({
  type: z.literal("hunger_reflex"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: hungerReflexPayloadSchema,
});

const breathReflexPayloadSchema = z.strictObject({
  airBefore: z.number(),
  airAfter: z.number().nullable(),
  healthBefore: z.number(),
  healthAfter: z.number(),
  /** Roof blocks dug through on the way up. */
  dug: z.number().int().nonnegative(),
  interrupted: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
});

const breathReflexEventInputSchema = z.strictObject({
  type: z.literal("breath_reflex"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: breathReflexPayloadSchema,
});

const fireReflexEventInputSchema = z.strictObject({
  type: z.literal("fire_reflex"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: z.strictObject({
    outcome: z.enum(["escaped", "blocked", "died"]),
    healthBefore: z.number(),
    healthAfter: z.number(),
    interrupted: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
  }),
});

const dragonReflexEventInputSchema = z.strictObject({
  type: z.literal("dragon_reflex"),
  observedAt: z.string().min(1),
  summary: z.string().min(1),
  payload: z.strictObject({
    outcome: z.enum(["evaded", "stopped", "failed"]),
    reason: z.string().nullable(),
    healthBefore: z.number(),
    healthAfter: z.number(),
    interrupted: z.strictObject({ action: z.string(), startedAt: z.string() }).nullable(),
  }),
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

const playerMessageEventSchema = playerMessageEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

const playerDeathEventSchema = playerDeathEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

const playerDimensionChangeEventSchema = playerDimensionChangeEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

const hostileEncounterEventSchema = hostileEncounterEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

const hungerReflexEventSchema = hungerReflexEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

const breathReflexEventSchema = breathReflexEventInputSchema.extend({
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
});

/** Read-only compatibility for durable events written before survival policy replaced combat policy. */
const historicalCombatPolicyEventSchema = z.strictObject({
  type: z.literal("combat_policy"),
  eventId: z.number().int().positive(),
  botId: z.string().min(1),
  observedAt: z.string(),
  summary: z.string(),
  payload: policySnapshotSchema.omit({ overrides: true }).extend({
    defaults: combatPolicySchema,
    effective: combatPolicySchema,
    override: z.strictObject({
      changes: changesSchema.shape.combat.unwrap(),
      lifetime: policyLifetimeSchema,
    }).nullable(),
  }),
});

export const botEventSchema = z.discriminatedUnion("type", [
  historicalCombatPolicyEventSchema,
  equipmentEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  survivalEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  combatEngagementEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  survivalPolicyEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  dragonReflexEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  strongholdLocatedEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  fireReflexEventInputSchema.extend({ eventId: z.number().int().positive(), botId: z.string().min(1) }),
  playerMessageEventSchema,
  playerDeathEventSchema,
  playerDimensionChangeEventSchema,
  hostileEncounterEventSchema,
  hungerReflexEventSchema,
  breathReflexEventSchema,
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
