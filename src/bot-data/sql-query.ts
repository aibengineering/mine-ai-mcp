import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { installDataDictionary } from "./minecraft-knowledge.js";
import type { SqlBotData, SqlBotDataRow } from "./sql-bot-data.js";

export interface SqlQueryCatalogEntry {
  readonly id: string;
  readonly produces: string;
  readonly sql: string;
  readonly parameterNames: readonly string[];
}

interface SqlQueryRowParser<Row> {
  readonly parseRow: (row: SqlBotDataRow) => Row;
}

export interface BoundSqlQuery<Row> {
  readonly definition: SqlQueryCatalogEntry & SqlQueryRowParser<Row>;
  readonly values: readonly SQLInputValue[];
}

type SqlQueryBindings<Names extends readonly string[]> = {
  readonly [Name in Names[number]]: SQLInputValue;
};

export interface SqlQueryDefinition<Names extends readonly string[], Row>
  extends SqlQueryCatalogEntry,
    SqlQueryRowParser<Row> {
  readonly parameterNames: Names;
  bind(parameters: SqlQueryBindings<Names>): BoundSqlQuery<Row>;
}

export interface ActionSqlQueries {
  readonly actionName: string;
  readonly queries: readonly SqlQueryCatalogEntry[];
}

/** Define one reusable read recipe, including the parameters needed to adapt it. */
export function defineSqlQuery<const Names extends readonly string[], Row>(definition: {
  readonly id: string;
  readonly produces: string;
  readonly sql: string;
  readonly parameterNames: Names;
  readonly parseRow: (row: SqlBotDataRow) => Row;
}): SqlQueryDefinition<Names, Row> {
  assertQueryDefinition(definition);
  const query: SqlQueryDefinition<Names, Row> = {
    ...definition,
    bind(parameters: SqlQueryBindings<Names>): BoundSqlQuery<Row> {
      return {
        definition: query,
        values: query.parameterNames.map((name) => parameters[name]),
      };
    },
  };
  return Object.freeze(query);
}

/** Execute one bound recipe through the bot-data read-only boundary. */
export function readSqlQuery<Row>(data: SqlBotData, query: BoundSqlQuery<Row>): Row[] {
  return data.read(query.definition.sql, ...query.values).map(query.definition.parseRow);
}

/** Execute one bound recipe on a connection already owned by a transaction. */
export function allSqlQuery<Row>(database: DatabaseSync, query: BoundSqlQuery<Row>): Row[] {
  return database.prepare(query.definition.sql).all(...query.values).map(query.definition.parseRow);
}

/** Execute one bound recipe for its first row on a connection already owned by a transaction. */
export function getSqlQuery<Row>(database: DatabaseSync, query: BoundSqlQuery<Row>): Row | undefined {
  const row = database.prepare(query.definition.sql).get(...query.values);
  return row && query.definition.parseRow(row);
}

/** Publish every SQL action's canonical read recipes in disposable runtime knowledge. */
export function installActionQueryCatalog(data: SqlBotData, actions: readonly ActionSqlQueries[]): void {
  const entries = catalogRows(actions);
  data.withWritableDatabase((database) => {
    database.exec(`
      CREATE TABLE knowledge.action_queries (
        action_name TEXT NOT NULL,
        query_id TEXT NOT NULL,
        produces TEXT NOT NULL,
        parameter_names TEXT NOT NULL,
        sql TEXT NOT NULL,
        PRIMARY KEY (action_name, query_id)
      ) STRICT;
    `);

    const insert = database.prepare(
      "INSERT INTO knowledge.action_queries (action_name, query_id, produces, parameter_names, sql) VALUES (?, ?, ?, ?, ?)",
    );
    for (const entry of entries) {
      insert.run(
        entry.actionName,
        entry.query.id,
        entry.query.produces,
        JSON.stringify(entry.query.parameterNames),
        entry.query.sql.trim(),
      );
    }

    installDataDictionary(database);
    describeActionQueryCatalog(database);
  }, { name: "installActionQueryCatalog" });
}

function catalogRows(
  actions: readonly ActionSqlQueries[],
): { readonly actionName: string; readonly query: SqlQueryCatalogEntry }[] {
  const definitions = new Map<string, SqlQueryCatalogEntry>();
  const rows: { readonly actionName: string; readonly query: SqlQueryCatalogEntry }[] = [];
  for (const action of actions) {
    for (const query of action.queries) {
      const existing = definitions.get(query.id);
      if (existing && querySignature(existing) !== querySignature(query)) {
        throw new TypeError(`SQL query id ${query.id} has conflicting definitions.`);
      }
      definitions.set(query.id, query);
      rows.push({ actionName: action.actionName, query });
    }
  }
  return rows;
}

function querySignature(query: SqlQueryCatalogEntry): string {
  return JSON.stringify([query.produces, query.parameterNames, query.sql.trim()]);
}

function assertQueryDefinition(definition: SqlQueryCatalogEntry): void {
  if (definition.id.trim().length === 0) throw new TypeError("SQL query id must not be empty.");
  if (definition.produces.trim().length === 0) throw new TypeError(`SQL query ${definition.id} must describe its result.`);
  if (!/^(SELECT|WITH)\b/i.test(definition.sql.trimStart())) {
    throw new TypeError(`SQL query ${definition.id} must be a SELECT or WITH read.`);
  }
  const uniqueNames = new Set(definition.parameterNames);
  if (uniqueNames.size !== definition.parameterNames.length) {
    throw new TypeError(`SQL query ${definition.id} has duplicate parameter names.`);
  }
}

function describeActionQueryCatalog(database: DatabaseSync): void {
  const descriptions = new Map<string | null, string>([
    [null, "Canonical read queries used by model-runnable actions, available for inspection and adaptation."],
    ["action_name", "MCP action whose implementation uses this query recipe."],
    ["query_id", "Stable identifier returned in that action's source evidence."],
    ["produces", "Meaning of the rows produced by the query."],
    ["parameter_names", "JSON array naming positional question-mark parameters in binding order."],
    ["sql", "Canonical parameterized SQLite SELECT or WITH statement used by the action."],
  ]);
  const update = database.prepare(
    "UPDATE data_dictionary SET description = ? WHERE database_name = 'knowledge' AND table_name = 'action_queries' AND column_name IS ?",
  );
  for (const [column, description] of descriptions) update.run(description, column);
}
