import { DatabaseSync } from "node:sqlite";
import type { Bot } from "mineflayer";
import type { SqlBotData } from "./sql-bot-data.js";

type KnowledgeCell = string | number | null;
type KnowledgeColumnType = "INTEGER" | "REAL" | "TEXT";

interface KnowledgeColumn {
  readonly name: string;
  readonly type: KnowledgeColumnType;
}

/** Install this Minecraft version's disposable knowledge beside stored bot data. */
export function installMinecraftKnowledge(data: SqlBotData, source: Bot["registry"]): void {
  data.withWritableDatabase((database) => {
    attachMinecraftKnowledge(database, source);
    installDataDictionary(database);
  }, { name: "installMinecraftKnowledge" });
}

/** Attach and atomically populate the disposable `knowledge` database directly from the connected registry. */
export function attachMinecraftKnowledge(database: DatabaseSync, source: Bot["registry"]): void {
  if (database.isTransaction) throw new Error("Minecraft knowledge cannot be attached inside a transaction.");

  database.exec("ATTACH DATABASE ':memory:' AS knowledge");
  try {
    database.exec("BEGIN IMMEDIATE");
    populateMinecraftKnowledge(database, source);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    try {
      database.exec("DETACH DATABASE knowledge");
    } catch {
      // Preserve the population error; closing the owner still disposes the attachment.
    }
    throw error;
  }
}

/** Publish runtime-derived knowledge tables and columns to the data dictionary. */
export function installDataDictionary(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM data_dictionary WHERE database_name = 'knowledge';

    INSERT INTO data_dictionary (database_name, table_name, column_name, description)
    SELECT
      'knowledge',
      object.name,
      NULL,
      'Runtime-derived table copied from the connected Minecraft registry.'
    FROM knowledge.sqlite_schema AS object
    WHERE object.type = 'table' AND object.name NOT LIKE 'sqlite_%';

    INSERT INTO data_dictionary (database_name, table_name, column_name, description)
    SELECT
      'knowledge',
      object.name,
      column.name,
      'Runtime-derived ' || column.type || ' column; nested registry values are JSON text.'
    FROM knowledge.sqlite_schema AS object
    JOIN pragma_table_info(object.name, 'knowledge') AS column
    WHERE object.type = 'table' AND object.name NOT LIKE 'sqlite_%';
  `);
}

function populateMinecraftKnowledge(database: DatabaseSync, source: Bot["registry"]): void {
  const registry = (source || {}) as unknown as Record<string, unknown>;
  const seenTableNames = new Set<string>();

  if (isRecord(registry.version)) {
    createAndPopulateTable(database, "source", [registry.version], seenTableNames);
  }

  for (const [property, value] of Object.entries(registry)) {
    if (property === "version" || property === "recipes" || !Array.isArray(value) || value.length === 0) continue;
    // Mineflayer may expose both `biomes` and its canonical `biomesArray`.
    // Prefer the conventional registry array instead of publishing two copies.
    if (!property.endsWith("Array") && Array.isArray(registry[`${property}Array`])) continue;

    const records = value.every(isRecord) ? value : value.map((entry) => ({ value: entry }));
    createAndPopulateTable(database, tableName(property), records, seenTableNames);
  }

  const recipes = recipeRows(registry.recipes);
  if (recipes.length > 0) {
    createAndPopulateTable(database, "recipes", recipes, seenTableNames);
  }
}

function createAndPopulateTable(
  database: DatabaseSync,
  name: string,
  records: readonly Record<string, unknown>[],
  seenTableNames: Set<string>,
): void {
  if (seenTableNames.has(name)) {
    throw new TypeError(`Duplicate knowledge table ${name}.`);
  }
  seenTableNames.add(name);

  const sourceKeys = [...new Set(records.flatMap((row) => Object.keys(row)))].filter((key) =>
    queryable(records.map((row) => row[key])),
  );
  if (sourceKeys.length === 0) {
    throw new TypeError(`knowledge.${name} must have at least one column.`);
  }

  const columnNames = sourceKeys.map(snakeCase);
  assertUnique(columnNames, `column in knowledge.${name}`);

  const columns: KnowledgeColumn[] = sourceKeys.map((key, index) => ({
    name: columnNames[index],
    type: columnType(records.map((row) => row[key])),
  }));

  const tableIdentifier = quote(name);
  const definitions = columns.map((column) => `${quote(column.name)} ${column.type}`).join(", ");
  database.exec(`CREATE TABLE knowledge.${tableIdentifier} (${definitions}) STRICT`);

  if (records.length === 0) return;
  const placeholders = columns.map(() => "?").join(", ");
  const insert = database.prepare(`INSERT INTO knowledge.${tableIdentifier} VALUES (${placeholders})`);
  for (const record of records) {
    const rowValues = sourceKeys.map((key, index) => cell(record[key], columns[index].type));
    insert.run(...rowValues);
  }
}

function recipeRows(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];

  const rows: Record<string, unknown>[] = [];
  for (const [resultItemId, alternatives] of Object.entries(value)) {
    if (!Array.isArray(alternatives)) continue;
    alternatives.forEach((alternative, alternativeIndex) => {
      rows.push({
        resultItemId: numericKey(resultItemId),
        alternativeIndex,
        ...(isRecord(alternative) ? alternative : { value: alternative }),
      });
    });
  }
  return rows;
}

function columnType(values: readonly unknown[]): KnowledgeColumnType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length > 0 && present.every((value) => typeof value === "boolean" || Number.isInteger(value))) {
    return "INTEGER";
  }
  if (present.length > 0 && present.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return "REAL";
  }
  return "TEXT";
}

function cell(value: unknown, type: KnowledgeColumnType): KnowledgeCell {
  if (value === null || value === undefined) return null;
  if (type === "INTEGER") return typeof value === "boolean" ? Number(value) : (value as number);
  if (type === "REAL") return value as number;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();

  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(`Minecraft registry value ${String(value)} cannot be stored as JSON.`);
  return encoded;
}

function queryable(values: readonly unknown[]): boolean {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length > 0 && present.every((value) => typeof value !== "function" && typeof value !== "symbol");
}

function tableName(property: string): string {
  return snakeCase(property.replace(/Array$/, ""));
}

function snakeCase(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (normalized.length === 0) throw new TypeError(`Minecraft registry name ${JSON.stringify(value)} is empty.`);
  return normalized;
}

function numericKey(value: string): string | number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertUnique(values: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`Duplicate ${context} ${value}.`);
    seen.add(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
