import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { installMinecraftKnowledge } from "./minecraft-knowledge.js";
import { defineSqlQuery, installActionQueryCatalog, readSqlQuery } from "./sql-query.js";
import { temporaryBotData } from "../test-support/bot-data.js";

const REGISTRY = { version: { minecraftVersion: "test" } } as unknown as Bot["registry"];

test("binds one canonical query definition for both execution and catalog inspection", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  installMinecraftKnowledge(data, REGISTRY);

  const query = defineSqlQuery({
    id: "test-value",
    produces: "The supplied test value.",
    parameterNames: ["value"] as const,
    sql: "SELECT ? AS value",
    parseRow: (row) => ({ value: Number(row.value) }),
  });

  assert.deepEqual(readSqlQuery(data, query.bind({ value: 42 })), [{ value: 42 }]);

  installActionQueryCatalog(data, [{ actionName: "test", queries: [query] }]);
  assert.deepEqual(
    data.read("SELECT action_name, query_id, produces, parameter_names, sql FROM knowledge.action_queries"),
    [
      {
        action_name: "test",
        query_id: "test-value",
        produces: "The supplied test value.",
        parameter_names: '["value"]',
        sql: "SELECT ? AS value",
      },
    ],
  );
  assert.deepEqual(
    data.read(
      "SELECT description FROM data_dictionary WHERE database_name = 'knowledge' AND table_name = 'action_queries' AND column_name = 'query_id'",
    ),
    [{ description: "Stable identifier returned in that action's source evidence." }],
  );
});
