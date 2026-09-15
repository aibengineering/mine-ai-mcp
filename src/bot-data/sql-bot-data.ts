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
  type StorageLockFailure,
  type StorageOperation,
  type StoragePhase,
} from "./storage-diagnostics.js";

export { BOT_DATA_SCHEMA };
export const SQL_BOT_DATA_SCHEMA_VERSION = 1;

/** Extend call statuses without rewriting any historical response payload. */
function migrateActionResponses(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'action_responses'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'accepted'")) return;
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE action_responses_async (
      request_id INTEGER PRIMARY KEY, responded_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
      status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','cancelled','accepted','refused','pending','storage_failed','cancellation_requested')),
      response_json TEXT NOT NULL CHECK(json_valid(response_json)),
      FOREIGN KEY(request_id) REFERENCES action_requests(request_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO action_responses_async SELECT * FROM action_responses;
    DROP TABLE action_responses;
    ALTER TABLE action_responses_async RENAME TO action_responses;
    COMMIT;`);
}

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

export interface SqlBotDataOptions {
  readonly storage: BotDataStorage;
  readonly identity: BotDataIdentity;
}

/** Owns the SQLite representation and connection for one bot-data identity. */
export class SqlBotData {
  readonly location: SqlBotDataLocation;

  private closed = false;
  private readonly database: DatabaseSync;
  private readonly connection;
  private lockFailures = 0;
  private lastLockFailure: StorageLockFailure | null = null;

  private constructor(location: SqlBotDataLocation, metadata: ReadonlyMap<string, string>) {
    this.location = location;
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
        validateExistingMetadata(database, metadata);
        migrateEventReadState(database);
        migrateBotStatus(database);
        migrateActionResponses(database);
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
      process.stderr.write(
        `[minecraft-bot-data] ${JSON.stringify({ event: "opened", ...this.connection, observedAt: new Date().toISOString() })}\n`,
      );
  }

  /** Creates the selected durable or session-only representation of one bot-data identity. */
  static create(options: SqlBotDataOptions): SqlBotData {
    const identity = resolveBotDataIdentity(options.identity);
    const metadata = metadataFor(identity.worldId, identity.scope);
    const location = resolveSqlBotDataLocation(options.storage, identity);
    return new SqlBotData(location, metadata);
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
      process.stderr.write(
        `[minecraft-bot-data] ${JSON.stringify({ event: "closed", ...this.connection, observedAt: new Date().toISOString() })}\n`,
      );
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
      process.stderr.write(`[minecraft-bot-data] ${JSON.stringify(details)}\n`);
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

/** Preserve the cursor created before event reading was separated from notification policy. */
function migrateEventReadState(database: DatabaseSync): void {
  const oldTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'notification_state'")
    .get();
  const currentTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'event_read_state'")
    .get();
  if (oldTable !== undefined && currentTable === undefined) {
    database.exec("ALTER TABLE notification_state RENAME TO event_read_state");
  }
}

/** The live-status row is rewritten on every refresh, so an outdated shape is dropped rather than altered. */
function migrateBotStatus(database: DatabaseSync): void {
  const columns = database.prepare("SELECT name FROM pragma_table_info('bot_status')").all() as { name: string }[];
  if (columns.length > 0 && !columns.some((column) => column.name === "time_of_day")) {
    database.exec("DROP TABLE bot_status");
  }
}

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

/** Reject incompatible files before schema installation can modify them. */
function validateExistingMetadata(database: DatabaseSync, expected: ReadonlyMap<string, string>): void {
  const metadataTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sql_bot_data_metadata'")
    .get();
  if (metadataTable === undefined) return;

  const find = database.prepare("SELECT value FROM sql_bot_data_metadata WHERE key = ?");
  for (const [key, expectedValue] of expected) {
    const existing = find.get(key) as { value: string } | undefined;
    if (existing !== undefined && existing.value !== expectedValue) {
      throw metadataMismatch(key, expectedValue, existing.value);
    }
  }
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
