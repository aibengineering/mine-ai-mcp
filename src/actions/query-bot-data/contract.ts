import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const QUERY_BOT_DATA = "query_bot_data" as const;

export const QUERY_BOT_DATA_MAX_SQL_BYTES = 16 * 1024;
export const QUERY_BOT_DATA_MAX_ROWS = 100;
export const QUERY_BOT_DATA_MAX_RESULT_BYTES = 64 * 1024;
export const QUERY_BOT_DATA_DESCRIPTION =
  "Query the bot's read-only SQLite data for its current status, remembered Minecraft world, durable event history, and connected game version. " +
  "Use it for position and vitals; observed chunks, container contents and locations, biomes, materials, water coverage, and frontier navigation; recorded player messages; or version-correct registry facts such as blocks, items, recipes, and entity types. " +
  "Query data_dictionary first when the schema is unknown; inspect knowledge.action_queries when another action references query IDs. " +
  "Keep queries focused and refine any truncated result.";

const sqlSchema = z
  .string()
  .min(1, "sql must not be empty")
  .max(QUERY_BOT_DATA_MAX_SQL_BYTES, `sql must be at most ${QUERY_BOT_DATA_MAX_SQL_BYTES} characters`)
  .refine((sql) => sql.trim().length > 0, "sql must not be blank")
  .refine(
    (sql) => Buffer.byteLength(sql, "utf8") <= QUERY_BOT_DATA_MAX_SQL_BYTES,
    `sql must be at most ${QUERY_BOT_DATA_MAX_SQL_BYTES} UTF-8 bytes`,
  );

export const queryBotDataInputSchema = z.strictObject({
  sql: sqlSchema.describe(
    "Exactly one SQLite SELECT or read-only WITH statement. When the schema is unknown, start with: SELECT database_name, table_name, column_name, description FROM data_dictionary ORDER BY database_name, table_name, column_name;",
  ),
});

export type QueryBotDataInput = z.output<typeof queryBotDataInputSchema>;

export const queryBotDataCellSchema = z.union([z.string(), z.number(), z.null()]);
export type QueryBotDataCell = z.output<typeof queryBotDataCellSchema>;

export const botDataQueryResultSchema = z
  .strictObject({
    columns: z.array(z.string()),
    rows: z.array(z.array(queryBotDataCellSchema)).max(QUERY_BOT_DATA_MAX_ROWS),
    returnedRows: z.number().int().nonnegative().max(QUERY_BOT_DATA_MAX_ROWS),
    truncated: z.boolean(),
  })
  .superRefine((result, context) => {
    if (result.returnedRows !== result.rows.length) {
      context.addIssue({ code: "custom", path: ["returnedRows"], message: "must equal rows.length" });
    }

    for (const [index, row] of result.rows.entries()) {
      if (row.length !== result.columns.length) {
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "must contain one value for every column",
        });
      }
    }
  });

export type BotDataQueryResult = z.output<typeof botDataQueryResultSchema>;

export const queryBotDataResultSchema = actionResultSchema({
  query: botDataQueryResultSchema,
});
export type QueryBotDataResult = z.output<typeof queryBotDataResultSchema>;
export type QueryBotDataOutput = ActionOutput<typeof QUERY_BOT_DATA, QueryBotDataResult>;

export const queryBotDataAnnotations = {
  openWorldHint: false,
} satisfies ToolAnnotations;

export function parseQueryBotDataInput(input: unknown): QueryBotDataInput {
  return queryBotDataInputSchema.parse(input);
}
