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

/**
 * note_read is the narrow form of query_bot_data, but it does not run through
 * that action's implementation: query_bot_data caps a result at 100 rows and
 * 64 KiB and answers with bare columns and rows, while note_read returns up to
 * `n` typed notes through a bound, registered query. Routing one through the
 * other would change what note_read returns, so the two share the bot-data
 * connection and nothing more.
 */
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
    parse: (input: unknown) => noteReadInputSchema.parse(input ?? {}),
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
