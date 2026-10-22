import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { resolveBotDataIdentity, type BotDataIdentity, type BotDataScope } from "./bot-data-identity.js";
import { BOT_DATA_SCHEMA } from "./bot-data-schema.js";
import {
  BotDataLockError,
  sqliteLock,
  storageConnection,
  type StorageConnection,
  type StorageLockFailure,
  type StorageOperation,
  type StoragePhase,
} from "./storage-diagnostics.js";

export { BOT_DATA_SCHEMA };
/**
 * The store's shape, recorded in each file's metadata. A file at an older
 * version is migrated forward when it opens, so a bot keeps its notes, its
 * event history and its learned queries across a runtime upgrade; a file at
 * a version this runtime does not know is refused with the file named, which
 * beats failing deep inside a later query. Version 2 retired the pre-survival
 * event types, the `notification_state` cursor table, the `bot_status` row
 * without `time_of_day`, and the synchronous-only call statuses.
 */
export const SQL_BOT_DATA_SCHEMA_VERSION = 2;

/** Event types version 1 could hold that nothing writes or reads any more. */
const RETIRED_EVENT_TYPES = [
  "hostile_encounter", "hunger_reflex", "breath_reflex", "fire_reflex", "dragon_reflex",
  "combat_engagement", "survival_policy", "combat_policy",
] as const;

export type SqlBotDataRow = Record<string, SQLOutputValue>;

export type BotDataStorage =
  | {
      readonly kind: "persistent";
      readonly root: string;
    }
  | {
      readonly kind: "temporary";
    };

export type SqlBotDataLocation =
  { readonly kind: "persistent"; readonly file: string } | { readonly kind: "temporary" };

/**
 * An operator record about the storage itself, which the database cannot hold:
 * a persistent connection opening or closing, or a lock failure on any connection.
 */
export type BotDataLogRecord =
  | ({ readonly event: "opened" | "closed" } & StorageConnection & { readonly observedAt: string })
  | StorageLockFailure;

/** The line an operator reads for one record: a tag, then the record as JSON. */
export function botDataLogLine(record: BotDataLogRecord): string {
  return `[minecraft-bot-data] ${JSON.stringify(record)}`;
}

/** Production's sink: one line per record on stderr, alongside the host's own notices. */
export function writeBotDataLog(record: BotDataLogRecord): void {
  process.stderr.write(`${botDataLogLine(record)}\n`);
}

export interface SqlBotDataOptions {
  readonly storage: BotDataStorage;
  readonly identity: BotDataIdentity;
  /** Where lifecycle and lock records go. Defaults to {@link writeBotDataLog}. */
  readonly log?: (record: BotDataLogRecord) => void;
}

/** Owns the SQLite representation and connection for one bot-data identity. */
export class SqlBotData {
  readonly location: SqlBotDataLocation;

  private closed = false;
  private readonly database: DatabaseSync;
  private readonly connection;
  private lockFailures = 0;
  private lastLockFailure: StorageLockFailure | null = null;
  private readonly log: (record: BotDataLogRecord) => void;

  private constructor(
    location: SqlBotDataLocation,
    metadata: ReadonlyMap<string, string>,
    log: (record: BotDataLogRecord) => void,
  ) {
    this.location = location;
    this.log = log;
    this.connection = storageConnection(location.kind === "persistent" ? location.file : ":memory:");

    const database = new DatabaseSync(location.kind === "persistent" ? location.file : ":memory:", {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database = database;

    try {
      this.at({ name: "open-bot-data" }, "configure", () => {
        configureDatabase(database, location.kind);
        migrateStore(database, location);
        validateExistingMetadata(database, metadata, location);
        database.exec(BOT_DATA_SCHEMA);
        installAndValidateMetadata(database, metadata);
        // Startup may wait for a transient migration/journal lock. Once attached
        // to the bot, a synchronous five-second wait would starve physics and
        // trip the runtime watchdog. Report contention to the caller immediately.
        database.exec("PRAGMA busy_timeout = 0");
        database.exec("PRAGMA query_only = ON");
      });
    } catch (error) {
      closeSqlDatabase(database);
      throw error;
    }
    // Cross-process contention cannot be attributed from the victim's SQLite error alone.
    // Lifecycle records let operators correlate other runtime connections to this exact file.
    if (location.kind === "persistent")
      this.log({ event: "opened", ...this.connection, observedAt: new Date().toISOString() });
  }

  /** Creates the selected durable or session-only representation of one bot-data identity. */
  static create(options: SqlBotDataOptions): SqlBotData {
    const identity = resolveBotDataIdentity(options.identity);
    const metadata = metadataFor(identity.worldId, identity.scope);
    const location = resolveSqlBotDataLocation(options.storage, identity);
    return new SqlBotData(location, metadata, options.log ?? writeBotDataLog);
  }

  /** Runs a trusted, synchronous read on the host thread. */
  read(sql: string, ...parameters: SQLInputValue[]): SqlBotDataRow[] {
    this.assertOpen();
    return this.readOnly(() => rows(this.database, sql, parameters), { name: "read-bot-data" });
  }

  /** Give trusted setup code synchronous writable access without imposing a transaction. */
  withWritableDatabase<T>(
    operation: (database: DatabaseSync) => T,
    context: StorageOperation = { name: "writable-setup" },
  ): T {
    this.assertOpen();
    if (this.database.isTransaction) {
      throw new Error("SqlBotData cannot enter writable setup while a transaction is active.");
    }

    using _cleanup = this.writeCleanup(context);
    this.at(context, "enable-write", () => this.database.exec("PRAGMA query_only = OFF"));
    const result = this.at(context, "operation", () => operation(this.database));
    if (isThenable(result)) {
      throw new TypeError("SqlBotData writable setup must be synchronous.");
    }
    if (this.database.isTransaction) {
      throw new Error("SqlBotData writable setup must settle its transaction before returning.");
    }
    return result;
  }

  /** Gives trusted package code temporary read-only access to the underlying connection. */
  withReadOnlyDatabase<T>(
    operation: (database: DatabaseSync) => T,
    context: StorageOperation = { name: "read-bot-data" },
  ): T {
    this.assertOpen();
    return this.readOnly(() => operation(this.database), context);
  }

  /** Runs one trusted host write atomically. Nested and asynchronous work is rejected. */
  transaction<T>(operation: (database: DatabaseSync) => T, context: StorageOperation = { name: "transaction" }): T {
    this.assertOpen();
    if (this.database.isTransaction) {
      throw new Error("SqlBotData transactions cannot be nested.");
    }

    using _cleanup = this.writeCleanup(context);
    this.at(context, "enable-write", () => this.database.exec("PRAGMA query_only = OFF"));
    this.at(context, "begin", () => this.database.exec("BEGIN IMMEDIATE"));
    const result = this.at(context, "operation", () => operation(this.database));
    if (isThenable(result)) {
      throw new TypeError("SqlBotData transactions must be synchronous.");
    }
    this.at(context, "commit", () => this.database.exec("COMMIT"));
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSqlDatabase(this.database);
    if (this.location.kind === "persistent")
      this.log({ event: "closed", ...this.connection, observedAt: new Date().toISOString() });
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqlBotData is closed.");
    }
  }

  /** No SQLite reads: health stays available during contention, and retains evidence after recovery. */
  diagnostics() {
    return { ...this.connection, lockFailures: this.lockFailures, lastLockFailure: this.lastLockFailure };
  }

  private at<T>(operation: StorageOperation, phase: StoragePhase, work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } catch (cause) {
      const native = sqliteLock(cause);
      if (!native) throw cause;
      const details: StorageLockFailure = Object.freeze({
        ...this.connection,
        ...native,
        operation: Object.freeze({ ...operation }),
        phase,
        observedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        transactionActive: this.database.isTransaction,
      });
      this.lockFailures += 1;
      this.lastLockFailure = details;
      // The database itself is unavailable. Do not try to persist this through events or receipts.
      this.log(details);
      throw new BotDataLockError(details, cause);
    }
  }

  /** Dispose in reverse order; SuppressedError preserves both the original and any cleanup failure. */
  private writeCleanup(context: StorageOperation): DisposableStack {
    const cleanup = new DisposableStack();
    cleanup.defer(() => this.at(context, "restore-read-only", () => this.database.exec("PRAGMA query_only = ON")));
    cleanup.defer(() => {
      if (this.database.isTransaction) this.at(context, "rollback", () => this.database.exec("ROLLBACK"));
    });
    return cleanup;
  }

  private readOnly<T>(operation: () => T, context: StorageOperation): T {
    if (this.database.isTransaction) {
      throw new Error("SqlBotData cannot read while a transaction is active.");
    }

    this.database.exec("PRAGMA query_only = ON");
    try {
      return this.at(context, "operation", operation);
    } finally {
      this.database.exec("PRAGMA query_only = ON");
    }
  }
}

/**
 * Closes a connection and releases the underlying file before returning.
 *
 * Bun's `node:sqlite` leaves a closed database's outstanding statements unfinalised, so the
 * native connection — and, on Windows, the lock on the database file — survives until the
 * orphaned statement wrappers are collected. Node finalises them during `close`, so the
 * collection below only runs under Bun.
 */
export function closeSqlDatabase(database: DatabaseSync): void {
  database.close();
  collectOrphanedStatements?.(true);
}

const collectOrphanedStatements = (globalThis as { Bun?: { gc: (synchronous: boolean) => void } }).Bun?.gc;

function resolveSqlBotDataLocation(storage: BotDataStorage, identity: BotDataIdentity): SqlBotDataLocation {
  if (storage.kind === "temporary") return Object.freeze({ kind: "temporary" });

  const directory = dataDirectoryFor(path.resolve(storage.root), identity.worldId, identity.scope);
  mkdirSync(directory, { recursive: true });
  return Object.freeze({ kind: "persistent", file: path.join(directory, "bot-data.sqlite") });
}

function dataDirectoryFor(root: string, worldId: string, scope: BotDataScope): string {
  const worldDirectory = path.join(root, identitySegment("world", worldId));
  if (scope.kind === "shared") return path.join(worldDirectory, "shared");
  return path.join(worldDirectory, "bots", identitySegment("bot", scope.botId));
}

function identitySegment(fallback: string, identity: string): string {
  const readable = identity
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${readable || fallback}-${digest}`;
}

function configureDatabase(database: DatabaseSync, location: SqlBotDataLocation["kind"]): void {
  // Journal initialization can also meet a reader's transient lock during restart.
  database.exec("PRAGMA busy_timeout = 5000");
  if (location === "persistent") database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
}

/**
 * Bring an existing file up to this runtime's schema before anything reads it.
 *
 * Runs before the schema script, whose CREATE IF NOT EXISTS would otherwise
 * install fresh tables beside the renamed old ones. A fresh file has no
 * metadata yet and needs nothing; a file already at this version needs
 * nothing; a version this runtime has never written is refused, since it is
 * newer than the code or not a bot-data file at all.
 */
function migrateStore(database: DatabaseSync, location: SqlBotDataLocation): void {
  const found = recordedSchemaVersion(database);
  if (found === undefined || found === String(SQL_BOT_DATA_SCHEMA_VERSION)) return;
  if (found === "1") {
    migrateV1ToV2(database);
    return;
  }
  throw schemaVersionMismatch(location, found);
}

function recordedSchemaVersion(database: DatabaseSync): string | undefined {
  const metadataTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sql_bot_data_metadata'")
    .get();
  if (metadataTable === undefined) return undefined;
  const row = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row?.value;
}

/**
 * Version 1 to 2, in one transaction so a crash midway leaves a version 1 file.
 *
 * Each step handles a shape version 1 files were seen with during development,
 * so each first checks whether the file still has it. The retired event rows
 * have no current shape to become and are deleted; the read cursor and every
 * other row stay.
 */
function migrateV1ToV2(database: DatabaseSync): void {
  const tableExists = (name: string): boolean =>
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists("notification_state") && !tableExists("event_read_state")) {
      database.exec("ALTER TABLE notification_state RENAME TO event_read_state");
    }
    const statusColumns = database.prepare("SELECT name FROM pragma_table_info('bot_status')").all() as { name: string }[];
    if (statusColumns.length > 0 && !statusColumns.some((column) => column.name === "time_of_day")) {
      // The live status is rewritten within a second of connecting; nothing is lost.
      database.exec("DROP TABLE bot_status");
    }
    const responses = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'action_responses'").get() as
      | { sql: string }
      | undefined;
    if (responses && !responses.sql.includes("'accepted'")) {
      database.exec(`
        CREATE TABLE action_responses_async (
          request_id INTEGER PRIMARY KEY, responded_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
          status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','cancelled','accepted','refused','pending','storage_failed','cancellation_requested')),
          response_json TEXT NOT NULL CHECK(json_valid(response_json)),
          FOREIGN KEY(request_id) REFERENCES action_requests(request_id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO action_responses_async SELECT * FROM action_responses;
        DROP TABLE action_responses;
        ALTER TABLE action_responses_async RENAME TO action_responses;`);
    }
    if (tableExists("events")) {
      const placeholders = RETIRED_EVENT_TYPES.map(() => "?").join(", ");
      database.prepare(`DELETE FROM events WHERE event_type IN (${placeholders})`).run(...RETIRED_EVENT_TYPES);
    }
    database.prepare("UPDATE sql_bot_data_metadata SET value = ? WHERE key = 'schema_version'").run(
      String(SQL_BOT_DATA_SCHEMA_VERSION),
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** Reject incompatible files before schema installation can modify them. */
function validateExistingMetadata(
  database: DatabaseSync,
  expected: ReadonlyMap<string, string>,
  location: SqlBotDataLocation,
): void {
  const metadataTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sql_bot_data_metadata'")
    .get();
  if (metadataTable === undefined) return;

  const find = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = ?");
  for (const [key, expectedValue] of expected) {
    const existing = find.get(key) as { value: string } | undefined;
    if (existing === undefined || existing.value === expectedValue) continue;
    if (key === "schema_version") throw schemaVersionMismatch(location, existing.value);
    throw metadataMismatch(key, expectedValue, existing.value);
  }
}

function schemaVersionMismatch(location: SqlBotDataLocation, found: string): Error {
  const store = location.kind === "persistent" ? `SQL bot data at ${location.file}` : "SQL bot data";
  return new Error(
    `${store} has schema version ${found}, but this runtime knows schema versions up to ${SQL_BOT_DATA_SCHEMA_VERSION}. ` +
      "Open it with the runtime that wrote it, or delete this file (with its -wal and -shm files) to recreate the store.",
  );
}

function installAndValidateMetadata(database: DatabaseSync, expected: ReadonlyMap<string, string>): void {
  const find = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = ?");
  const insert = database.prepare("INSERT INTO sql_bot_data_metadata (key, value) VALUES (?, ?)");

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, expectedValue] of expected) {
      const existing = find.get(key) as { value: string } | undefined;
      if (existing === undefined) {
        insert.run(key, expectedValue);
      } else if (existing.value !== expectedValue) {
        throw metadataMismatch(key, expectedValue, existing.value);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function metadataMismatch(key: string, expected: string, actual: string): Error {
  return new Error(
    `SQL bot data identity mismatch for ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`,
  );
}

function metadataFor(worldId: string, scope: BotDataScope): ReadonlyMap<string, string> {
  return new Map([
    ["schema_version", String(SQL_BOT_DATA_SCHEMA_VERSION)],
    ["world_id", worldId],
    ["scope_kind", scope.kind],
    ["bot_id", scope.kind === "bot" ? scope.botId : ""],
  ]);
}

function rows(database: DatabaseSync, sql: string, parameters: SQLInputValue[]): SqlBotDataRow[] {
  return database
    .prepare(sql)
    .all(...parameters)
    .map((row) => ({ ...row }));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === "object" && value !== null) || typeof value === "function") && "then" in value;
}
