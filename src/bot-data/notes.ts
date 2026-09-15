import { z } from "zod";
import type { SqlBotDataRow } from "./sql-bot-data.js";

export const botNoteSchema = z.strictObject({
  noteId: z.number().int().positive(),
  botId: z.string().min(1),
  note: z.string().min(1),
  context: z.string().min(1),
  rememberedAt: z.iso.datetime(),
  dimension: z.string().min(1),
  position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  // Keep the raw world clock. If personal playtime is needed later, a view can
  // sum connected intervals using world-age ticks captured at connect/disconnect
  // events, then calculate bot time at each note without changing stored notes.
  worldAgeTicks: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Latest server-reported world age in game ticks; null before the first time update. " +
        "Persists across server restarts and excludes time while the world is stopped. " +
        "This is world time, not the bot's personal playtime; it advances while the world ticks without the bot.",
    ),
});

export type BotNote = z.output<typeof botNoteSchema>;

/** Parse the persisted note once at the SQLite boundary. */
export function parseBotNote(row: SqlBotDataRow): BotNote {
  return botNoteSchema.parse({
    noteId: row.note_id,
    botId: row.bot_id,
    note: row.note,
    context: row.context,
    rememberedAt: row.remembered_at,
    dimension: row.dimension,
    position: { x: row.x, y: row.y, z: row.z },
    worldAgeTicks: row.world_age_ticks,
  });
}
