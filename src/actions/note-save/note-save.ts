import { executionCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { parseBotNote } from "../../bot-data/notes.js";
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineAction } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  NOTE_SAVE,
  NOTE_SAVE_DESCRIPTION,
  noteSaveInputSchema,
  noteSaveResultSchema,
  parseNoteSaveRequest,
} from "./contract.js";

export function createNoteSaveAction(bot: Bot, data: SqlBotData) {
  return defineAction({
    checkpointSchema: executionCheckpointSchema,
    name: NOTE_SAVE,
    description: NOTE_SAVE_DESCRIPTION,
    inputSchema: noteSaveInputSchema,
    resultSchema: noteSaveResultSchema,
    parse: parseNoteSaveRequest,
    execution: { kind: "task" },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    formatResult: (result) =>
      `Saved note #${result.note.noteId}.\n\n${markdownCodeBlock(JSON.stringify(result.note, null, 2))}`,
    execute: async (request, context) => {
      context.signal?.throwIfAborted();
      const { x, y, z } = bot.entity.position;
      const note = data.transaction((database) => {
        const row = database
          .prepare(
            `
          INSERT INTO notes (bot_id, note, context, remembered_at, dimension, x, y, z, world_age_ticks)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING *
        `,
          )
          .get(
            bot.username,
            request.note,
            request.context,
            new Date().toISOString(),
            bot.game.dimension,
            x,
            y,
            z,
            bot.time.age ?? null,
          );
        if (!row) throw new Error("Note insert returned no stored row.");
        return parseBotNote(row);
      }, { name: "createNoteSaveAction" });
      return { status: "succeeded", note };
    },
  });
}
