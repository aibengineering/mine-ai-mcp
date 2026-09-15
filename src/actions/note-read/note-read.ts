import { parseBotNote } from "../../bot-data/notes.js";
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineSqlQuery, readSqlQuery, type SqlQueryCatalogEntry } from "../../bot-data/sql-query.js";
import type { OneShotAction } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import { defineSqlAction, sqlActionSource } from "../sql-action.js";
import {
  NOTE_READ,
  NOTE_READ_DESCRIPTION,
  noteReadInputSchema,
  noteReadResultSchema,
  parseNoteReadRequest,
  type NoteReadRequest,
  type NoteReadResult,
} from "./contract.js";

export const latestNotesQuery = defineSqlQuery({
  id: "latest-bot-notes",
  produces: "The latest N notes saved by one bot in this world, newest first.",
  parameterNames: ["botId", "n"] as const,
  sql: "SELECT * FROM main.notes WHERE bot_id = ? ORDER BY note_id DESC LIMIT ?",
  parseRow: parseBotNote,
});

export function createNoteReadAction(
  data: SqlBotData,
  botId: string,
): OneShotAction<typeof NOTE_READ, NoteReadRequest, NoteReadResult> & {
  readonly queries: readonly SqlQueryCatalogEntry[];
} {
  return defineSqlAction({
    name: NOTE_READ,
    description: NOTE_READ_DESCRIPTION,
    inputSchema: noteReadInputSchema,
    resultSchema: noteReadResultSchema,
    parse: parseNoteReadRequest,
    execution: { kind: "information" },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    queries: [latestNotesQuery],
    formatResult: (result) =>
      result.notes.length === 0
        ? "No saved notes."
        : `${result.notes.length} saved notes, newest first.\n\n${markdownCodeBlock(JSON.stringify(result.notes, null, 2))}`,
    execute: async (request, context) => {
      context.signal?.throwIfAborted();
      return {
        status: "succeeded",
        notes: readSqlQuery(data, latestNotesQuery.bind({ botId, n: request.n })),
        source: sqlActionSource([latestNotesQuery]),
      };
    },
  });
}
