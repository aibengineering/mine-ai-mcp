import { constants, type DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineAction } from "../action.js";
import {
  QUERY_BOT_DATA_MAX_RESULT_BYTES,
  QUERY_BOT_DATA_MAX_ROWS,
  QUERY_BOT_DATA,
  QUERY_BOT_DATA_DESCRIPTION,
  parseQueryBotDataInput,
  queryBotDataAnnotations,
  queryBotDataInputSchema,
  botDataQueryResultSchema,
  queryBotDataResultSchema,
  type QueryBotDataCell,
  type QueryBotDataInput,
  type BotDataQueryResult,
  type QueryBotDataResult,
} from "./contract.js";

const ALLOWED_QUERY_ACTIONS = new Set<number>([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

/** Execute one model-authored read on the bot's existing SQLite connection. */
export async function queryBotData(
  botData: SqlBotData,
  request: QueryBotDataInput,
  signal?: AbortSignal,
): Promise<BotDataQueryResult> {
  signal?.throwIfAborted();

  return botData.withReadOnlyDatabase((database) => {
    database.setAuthorizer((action) =>
      ALLOWED_QUERY_ACTIONS.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY,
    );
    try {
      return executeRead(database, request.sql);
    } finally {
      database.setAuthorizer(null);
    }
  }, { name: "queryBotData" });
}

function markdownCell(value: QueryBotDataCell): string {
  if (value === null) return "null";
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

export function formatQueryBotDataResult(result: QueryBotDataResult): string {
  const { query } = result;
  const lines = [`Returned **${query.returnedRows}** row${query.returnedRows === 1 ? "" : "s"}.`];
  if (query.columns.length > 0) {
    lines.push(
      `| ${query.columns.map(markdownCell).join(" | ")} |`,
      `| ${query.columns.map(() => "---").join(" | ")} |`,
      ...query.rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
    );
  }
  if (query.truncated) lines.push("", "**Result truncated.** Refine the query to retrieve the remaining data.");
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

/** Bind one bot-data connection into the generic model-runnable action contract. */
export function createQueryBotDataAction(botData: SqlBotData, syncStatus?: () => void) {
  return defineAction({
    name: QUERY_BOT_DATA,
    description: QUERY_BOT_DATA_DESCRIPTION,
    inputSchema: queryBotDataInputSchema,
    resultSchema: queryBotDataResultSchema,
    formatResult: formatQueryBotDataResult,
    execution: { kind: "information" },
    annotations: queryBotDataAnnotations,
    parse: parseQueryBotDataInput,
    execute: async (request, context) => {
      syncStatus?.();
      return {
        status: "succeeded",
        query: await queryBotData(botData, request, context.signal),
      };
    },
  });
}

function executeRead(database: DatabaseSync, sql: string): BotDataQueryResult {
  if (!/^(SELECT|WITH)\b/i.test(sql.trimStart())) {
    throw new Error("SQL query rejected: exactly one read-only SELECT or WITH statement is required.");
  }

  try {
    const statement = database.prepare(sql, { readBigInts: true, returnArrays: true });
    if (sql.slice(statement.sourceSQL.length).trim().length > 0) {
      throw new Error("SQL query rejected: exactly one statement is allowed.");
    }

    const columns = statement.columns().map((column) => column.name);
    const rows: QueryBotDataCell[][] = [];
    let truncated = false;

    for (const rawRow of statement.iterate() as Iterable<SQLOutputValue[]>) {
      if (rows.length === QUERY_BOT_DATA_MAX_ROWS) {
        truncated = true;
        break;
      }

      const row = rawRow.map(outputValue);
      const candidate = result(columns, [...rows, row], false);
      if (serializedBytes(candidate) > QUERY_BOT_DATA_MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }
      rows.push(row);
    }

    return botDataQueryResultSchema.parse(result(columns, rows, truncated));
  } catch (error) {
    if (/not authorized|readonly|read-only/i.test(errorMessage(error))) {
      throw new Error("SQL query rejected: only read-only SELECT and WITH statements are allowed.");
    }
    throw error;
  }
}

function result(columns: string[], rows: QueryBotDataCell[][], truncated: boolean): BotDataQueryResult {
  return { columns, rows, returnedRows: rows.length, truncated };
}

function serializedBytes(value: BotDataQueryResult): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function outputValue(value: SQLOutputValue): QueryBotDataCell {
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("SQL query returned a non-finite number, which JSON cannot represent.");
    }
    return value;
  }
  if (typeof value === "string") return value;
  if (value === null) return null;
  throw new Error("SQL query returned a BLOB. Select hex(value) when binary data is needed.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
