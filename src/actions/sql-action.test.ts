import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineSqlQuery } from "../bot-data/index.js";
import { actionSqlQueries, defineSqlAction, sqlActionResultSchema, sqlActionSource } from "./sql-action.js";

const resultSchema = sqlActionResultSchema({ value: z.number() });
type Result = z.output<typeof resultSchema>;

test("a SQL action adds standard source evidence and Markdown without action boilerplate", async () => {
  const query = defineSqlQuery({
    id: "test-action-value",
    produces: "One value used by the test action.",
    parameterNames: [] as const,
    sql: "SELECT 7 AS value",
    parseRow: (row) => Number(row.value),
  });
  const queries = [query] as const;
  const action = defineSqlAction<"test", Record<string, never>, Result>({
    name: "test",
    description: "Test the SQL action contract.",
    inputSchema: z.strictObject({}),
    resultSchema,
    queries,
    execution: { kind: "information" },
    parse: () => ({}),
    execute: async () => ({ status: "succeeded", value: 7, source: sqlActionSource(queries) }),
    formatResult: (result) => `Value: ${result.value}`,
  });

  const result = await action.execute({}, {});
  assert.deepEqual(result, {
    status: "succeeded",
    value: 7,
    source: { queryIds: ["test-action-value"] },
  });
  assert.equal(
    action.formatResult(result),
    "Value: 7\n\nQueries supporting these data are in `knowledge.action_queries` where `action_name = 'test'`.",
  );
  assert.deepEqual(actionSqlQueries([action]), [{ actionName: "test", queries: [query] }]);
});
