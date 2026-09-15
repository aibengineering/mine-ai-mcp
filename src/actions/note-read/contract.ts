import { z } from "zod";
import { botNoteSchema } from "../../bot-data/notes.js";
import { sqlActionSourceSchema } from "../sql-action.js";

export const NOTE_READ = "note_read" as const;
export const NOTE_READ_DESCRIPTION =
  "Read this bot's latest N saved notes in this world, newest first, including context, UTC time, " +
  "dimension, position, and world age in ticks. Reading does not mark, change, or delete notes. " +
  "Use query_bot_data on main.notes for older notes or other filters.";

export const noteReadInputSchema = z.strictObject({
  n: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Number of latest notes to return, newest first. Defaults to 10."),
});

export const noteReadResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  notes: z.array(botNoteSchema),
  source: sqlActionSourceSchema,
});

export type NoteReadRequest = z.output<typeof noteReadInputSchema>;
export type NoteReadResult = z.output<typeof noteReadResultSchema>;

export function parseNoteReadRequest(input: unknown) {
  return noteReadInputSchema.parse(input ?? {});
}
