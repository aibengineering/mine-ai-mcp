import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import type { BotDataScope } from "./bot-data-identity.js";
import { closeSqlDatabase, SqlBotData } from "./sql-bot-data.js";
import { persistentBotData } from "../test-support/bot-data.js";
import { BotDataLockError } from "./storage-diagnostics.js";
import { queryBotData } from "../actions/query-bot-data/query-bot-data.js";

/**
 * A persistent storage root, with every store opened in it closed before the
 * directory is removed: Windows refuses to remove an open SQLite file.
 */

/** One in-memory store, closed when this test finishes. */
function temporarySqlBotData(t: TestContext, worldId = "temporary-world", scope: BotDataScope = { kind: "shared" }) {
  const data = SqlBotData.create({ storage: { kind: "temporary" }, identity: { worldId, scope } });
  t.after(() => data.close());
  return data;
}

function persistentFile(data: SqlBotData): string {
  if (data.location.kind !== "persistent") throw new Error("Expected persistent SQL bot data.");
  return data.location.file;
}

/** A table every isolation test writes its one observation into. */
function withObservations(data: SqlBotData): SqlBotData {
  data.transaction((database) => database.exec("CREATE TABLE observations (name TEXT PRIMARY KEY) STRICT"));
  return data;
}

test("async call migration preserves historical replies and publishes execution storage", (t) => {
  const storage = persistentBotData(t);
  const original = storage.open("async-migration");
  const historical = JSON.stringify({ response: { format: "markdown", markdown: "Original physical evidence\nunchanged" } });
  original.transaction((db) => {
    db.exec(`DROP TABLE action_responses;
      CREATE TABLE action_responses (
        request_id INTEGER PRIMARY KEY, responded_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','cancelled')),
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        FOREIGN KEY(request_id) REFERENCES action_requests(request_id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO action_requests VALUES (1, 'AsyncBot', 'navigate', 'Original intent', '2026-09-12T00:00:00Z', '{}');`);
    db.prepare("INSERT INTO action_responses VALUES (1, ?, 1234, 'succeeded', ?)").run("2026-09-12T00:00:01Z", historical);
  });
  original.close();
  const migrated = storage.open("async-migration");
  assert.deepEqual(migrated.read("SELECT duration_ms, status, response_json FROM action_responses"), [
    { duration_ms: 1234, status: "succeeded", response_json: historical },
  ]);
  migrated.transaction((db) => {
    db.exec("INSERT INTO action_requests VALUES (2, 'AsyncBot', 'navigate', 'Async intent', '2026-09-12T00:00:02Z', '{}')");
    db.exec("INSERT INTO action_responses VALUES (2, '2026-09-12T00:00:02Z', 1, 'accepted', '{}')");
  });
  assert.equal(migrated.read("SELECT description FROM data_dictionary WHERE table_name = 'action_executions'").length, 5);
  assert.deepEqual(migrated.read("PRAGMA foreign_key_check"), []);
});

test("runtime lock contention reports an error without consuming the watchdog allowance", (t) => {
  const storage = persistentBotData(t);
  const data = storage.open("locked-runtime");
  const writer = new DatabaseSync(persistentFile(data));
  storage.alsoClose(() => {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    closeSqlDatabase(writer);
  });

  writer.exec("BEGIN IMMEDIATE");
  const began = performance.now();
  assert.throws(
    () => data.transaction(() => {}, { name: "recordActionResponse", requestId: 115 }),
    (error) => {
      assert.ok(error instanceof BotDataLockError);
      assert.equal(error.details.phase, "begin");
      assert.equal(error.details.sqliteCode, 5);
      assert.equal(error.details.file, persistentFile(data));
      assert.equal(error.details.pid, process.pid);
      assert.equal(error.details.transactionActive, false);
      assert.deepEqual(error.details.operation, { name: "recordActionResponse", requestId: 115 });
      assert.ok(error.cause instanceof Error);
      assert.match(error.details.stack!, /sql-bot-data.test/);
      return true;
    },
  );
  // A broad one-second ceiling distinguishes immediate rejection from the
  // observed five-second synchronous SQLite wait, without timing normal SQL.
  assert.ok(performance.now() - began < 1000, "Lock contention must not block the runtime for seconds.");
  assert.equal(data.diagnostics().lockFailures, 1, "Diagnostic reads must work while the other writer holds its lock.");
  assert.equal(data.read("PRAGMA query_only")[0]?.query_only, 1);
  writer.exec("ROLLBACK");
  assert.equal(
    data.transaction(() => "recovered"),
    "recovered",
  );
  assert.equal(data.diagnostics().lastLockFailure?.operation.requestId, 115, "Keep the failure after recovery.");
});

test("distinguishes a stale read snapshot from an active competing writer", (t) => {
  const storage = persistentBotData(t);
  const data = withObservations(storage.open("stale-snapshot"));
  data.transaction((db) => db.exec("INSERT INTO observations VALUES ('one'), ('two')"));
  const writer = new DatabaseSync(persistentFile(data));
  storage.alsoClose(() => closeSqlDatabase(writer));
  // Deliberately leave a native cursor open to reproduce SQLITE_BUSY_SNAPSHOT.
  // isTransaction is false here: that property does not detect this implicit read snapshot.
  const cursor = data.withReadOnlyDatabase((db) => db.prepare("SELECT * FROM observations").iterate());
  try {
    cursor.next();
    writer.exec("INSERT INTO observations VALUES ('three')");
    assert.throws(
      () => data.transaction(() => {}),
      (error) => {
        assert.ok(error instanceof BotDataLockError);
        assert.equal(error.details.sqliteCode, 517);
        assert.equal(error.details.phase, "begin");
        assert.equal(error.details.transactionActive, false);
        return true;
      },
    );
  } finally {
    cursor.return?.();
  }
  assert.equal(
    data.transaction(() => "recovered"),
    "recovered",
  );
});

test("bounded and rejected public SQL reads release their cursors before a later write", async (t) => {
  const storage = persistentBotData(t);
  const data = withObservations(storage.open("read-lifetime"));
  data.transaction((db) =>
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<150)
    INSERT INTO observations SELECT CAST(x AS TEXT) FROM n`),
  );
  const writer = new DatabaseSync(persistentFile(data));
  storage.alsoClose(() => closeSqlDatabase(writer));
  const result = await queryBotData(data, { sql: "SELECT name FROM observations" });
  assert.equal(result.truncated, true);
  writer.exec("INSERT INTO observations VALUES ('after truncation')");
  data.transaction((db) => db.exec("INSERT INTO observations VALUES ('local after truncation')"));
  await assert.rejects(queryBotData(data, { sql: "SELECT CAST(name AS BLOB) FROM observations" }), /BLOB/);
  writer.exec("INSERT INTO observations VALUES ('after rejection')");
  data.transaction((db) => db.exec("INSERT INTO observations VALUES ('local after rejection')"));
  assert.equal(data.diagnostics().lockFailures, 0);
});

test("waits for a transient database lock while configuring persistent storage", async (t) => {
  const storage = persistentBotData(t);
  const initial = storage.open("locked-startup");
  const file = persistentFile(initial);
  initial.close();
  // Release on another thread: opening SqlBotData blocks this thread in SQLite.
  const locker = new Worker(
    `
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");
    const database = new DatabaseSync(workerData);
    database.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
    }, 250);
  `,
    { eval: true, workerData: file },
  );
  storage.alsoClose(() => void locker.terminate());
  await once(locker, "message");

  const reopened = storage.open("locked-startup");
  assert.deepEqual(reopened.read("PRAGMA journal_mode"), [{ journal_mode: "wal" }]);
});

test("persistent files are stable per world and scope, and neither shares the other's writes", (t) => {
  const storage = persistentBotData(t);
  const shared = storage.open("local/world");
  const sameShared = storage.open("local/world");
  // A world id that differs only where the file name would be sanitised.
  const collisionSafeWorld = storage.open("local-world");
  const collector = storage.open("local/world", { kind: "bot", botId: "collector" });
  const builder = storage.open("local/world", { kind: "bot", botId: "builder" });

  assert.equal(persistentFile(shared), persistentFile(sameShared));
  assert.notEqual(persistentFile(shared), persistentFile(collisionSafeWorld));
  assert.notEqual(persistentFile(shared), persistentFile(collector));
  assert.notEqual(persistentFile(collector), persistentFile(builder));
  assert.match(persistentFile(shared), /[\\/]shared[\\/]bot-data\.sqlite$/);
  assert.match(persistentFile(collector), /[\\/]bots[\\/].+[\\/]bot-data\.sqlite$/);

  for (const data of [shared, collector, builder]) withObservations(data);
  shared.transaction((database) => database.prepare("INSERT INTO observations VALUES (?)").run("shared"));
  collector.transaction((database) => database.prepare("INSERT INTO observations VALUES (?)").run("collector"));

  assert.deepEqual(sameShared.read("SELECT name FROM observations"), [{ name: "shared" }]);
  assert.deepEqual(collector.read("SELECT name FROM observations"), [{ name: "collector" }]);
  assert.deepEqual(builder.read("SELECT name FROM observations"), []);
});

test("opens an isolated in-memory representation for disposable work", (t) => {
  const data = withObservations(temporarySqlBotData(t, "world", { kind: "bot", botId: "collector" }));
  const other = temporarySqlBotData(t, "world", { kind: "bot", botId: "collector" });

  data.transaction((database) => database.prepare("INSERT INTO observations VALUES (?)").run("coal_ore"));

  assert.deepEqual(data.location, { kind: "temporary" });
  assert.deepEqual(data.read("SELECT name FROM observations"), [{ name: "coal_ore" }]);
  assert.throws(() => other.read("SELECT name FROM observations"), /no such table/);
  assert.deepEqual(data.read("SELECT key, value FROM sql_bot_data_metadata ORDER BY key"), [
    { key: "bot_id", value: "collector" },
    { key: "schema_version", value: "1" },
    { key: "scope_kind", value: "bot" },
    { key: "world_id", value: "world" },
  ]);
});

test("temporary storage enforces the same identity contract as persistent storage", () => {
  const create = (worldId: string, scope: BotDataScope) =>
    SqlBotData.create({ storage: { kind: "temporary" }, identity: { worldId, scope } });

  assert.throws(() => create("", { kind: "shared" }), /worldId must not be empty/);
  assert.throws(() => create("world", { kind: "bot", botId: "" }), /scope\.botId must not be empty/);
});

test("a transaction is synchronous, all-or-nothing, and never interleaved with a read", (t) => {
  const data = withObservations(temporarySqlBotData(t));

  assert.throws(
    () =>
      data.transaction((database) => {
        database.prepare("INSERT INTO observations (name) VALUES (?)").run("iron_ore");
        throw new Error("chunk observation failed");
      }),
    /chunk observation failed/,
  );
  assert.throws(
    () =>
      data.transaction(async (database) => {
        database.prepare("INSERT INTO observations (name) VALUES (?)").run("diamond_ore");
      }),
    /transactions must be synchronous/,
  );
  assert.deepEqual(data.read("SELECT name FROM observations"), [], "neither failure leaves a written row behind");

  assert.throws(() => data.transaction(() => data.read("SELECT 1")), /cannot read while a transaction is active/);
  assert.deepEqual(data.read("SELECT 1 AS healthy"), [{ healthy: 1 }]);
});

test("host reads cannot mutate temporary or persistent bot data", (t) => {
  const sources = [temporarySqlBotData(t), persistentBotData(t).open("persistent-world")];

  for (const data of sources) {
    assert.throws(
      () => data.read("INSERT INTO sql_bot_data_metadata (key, value) VALUES ('intruder', 'true')"),
      /read.?only/i,
    );
    data.read("PRAGMA query_only = OFF");
    assert.throws(
      () => data.read("INSERT INTO sql_bot_data_metadata (key, value) VALUES ('intruder', 'true')"),
      /read.?only/i,
    );
  }
});

test("rejects a SQL database whose recorded identity has been altered", (t) => {
  const storage = persistentBotData(t);
  const data = storage.open("world");
  const file = persistentFile(data);
  data.close();

  const database = new DatabaseSync(file);
  database.prepare("UPDATE sql_bot_data_metadata SET value = ? WHERE key = 'world_id'").run("another-world");
  closeSqlDatabase(database);

  assert.throws(() => storage.open("world"), /SQL bot data identity mismatch for world_id/);
});

test("close is idempotent and rejects later SQL work", (t) => {
  const data = temporarySqlBotData(t);

  data.close();
  data.close();

  assert.throws(() => data.read("SELECT 1"), /SqlBotData is closed/);
  assert.throws(() => data.transaction(() => undefined), /SqlBotData is closed/);
});
