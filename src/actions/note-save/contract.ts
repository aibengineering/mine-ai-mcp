import { z } from "zod";
import { botNoteSchema } from "../../bot-data/notes.js";

export const NOTE_SAVE = "note_save" as const;
export const NOTE_SAVE_DESCRIPTION =
  "Save one free-form note for this bot in this world. Records the note, its context, UTC time, " +
  "current dimension and position, and latest server-reported world age in ticks (not personal playtime). " +
  "Each call appends a new note; notes persist with bot data across restarts.";

export const noteSaveInputSchema = z.strictObject({
  note: z.string().trim().min(1).describe("The fact, lesson, reminder, or other note to remember."),
  context: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Details of the motivation and context for storing this note: why it matters, " +
        "what was happening, and what prompted you to remember it.",
    ),
});

export const noteSaveResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  note: botNoteSchema,
});

export function parseNoteSaveRequest(input: unknown) {
  return noteSaveInputSchema.parse(input);
}
