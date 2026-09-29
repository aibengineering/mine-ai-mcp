import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { CombatDecision } from "../survival/control/combat/contract.js";

import type { Bot } from "mineflayer";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Vec3 } from "vec3";
import { readRecentEventsResultSchema } from "../actions/read-recent-events/contract.js";
import { ExecutionScope } from "../execution/execution-scope.js";
import { CombatExecution, combatExecutionSnapshotSchema } from "../survival/control/combat/execution.js";
import { deferred } from "../test-support/async.js";
import { botFixture } from "../test-support/bot.js";
import { fakeCombat } from "../test-support/hunt-mob.js";
import { createMinecraftRuntime } from "./minecraft-runtime.js";

/** Runtime options for a store that lives only as long as the test. */
function temporaryStorage(worldId: string, botId = "runtime-bot") {
  return { storage: { kind: "temporary" as const }, identity: { worldId, scope: { kind: "bot" as const, botId } } };
}

function runtimeBot(controlStates: boolean[] = [], rejectedListener?: string): Bot {
  const bot = botFixture(
    { username: "RuntimeBot", position: new Vec3(0, 64, 0), slots: new Array(46).fill(null) },
    {
      _client: new EventEmitter(),
      getControlState: () => false,
      // Nothing loaded, and a registry with only what the runtime's observers
      // read, so no reflex acts on the world and the knowledge tables stay small.
      blockAt: () => null,
      setControlState: (control: string, state: boolean) => {
        if (control === "jump") controlStates.push(state);
      },
      world: { getColumns: () => [], getColumn: () => undefined },
      registry: {
        version: { minecraftVersion: "test" },
        entitiesByName: { player: { metadataKeys: ["shared_flags"] } },
        blocksByStateId: {},
        biomes: {},
        foodsByName: {},
      },
    },
  );
  bot.entity.id = 5;
  const botEvents = bot as unknown as EventEmitter;
  if (rejectedListener) {
    const addListener = botEvents.on.bind(botEvents);
    const rejectSelectedListener: EventEmitter["on"] = (eventName, listener) => {
      if (eventName === rejectedListener) throw new Error(`Listener registration failed for ${rejectedListener}.`);
      return addListener(eventName, listener);
    };
    botEvents.on = rejectSelectedListener;
  }
  bot.chat = (message) => bot.emit("chat", bot.username, message, null, {} as never, null);
  return bot;
}

test("completed combat decisions are retained without a physics sample and unsubscribe on close", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "combat-decision-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const listeners = new Set<(event: CombatDecision) => void>();
  const runtime = await createMinecraftRuntime(runtimeBot(), {
    incidents: { directory },
    botData: temporaryStorage("decision-test"),
    createCombatController: () => ({
      ...fakeCombat,
      onDecision: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
  });
  try {
    for (const listener of listeners) {
      listener({
        kind: "roof_prepared",
        targetId: 7,
        cell: new Vec3(0, 64, 0),
        stopped: "Roof occupied by the target",
      });
      listener({ kind: "retarget", from: 7, to: 8 });
    }
    await runtime.captureIncident();
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const records = (await readFile(path.join(directory, files[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.filter((record) => record.kind === "combat_decision").map((record) => record.event.kind),
      ["roof_prepared", "retarget"],
    );
    using trace = new ExecutionScope({ bot: "RuntimeBot", operation: "combat", targetId: 7 });
    const execution = new CombatExecution(trace);
    const start = execution.progress.snapshot().startedAt;
    execution.progress.observe(20, start);
    for (const state of ["started", "waiting", "ended"] as const) {
      if (state === "waiting") execution.progress.observe(20, start + 15_000);
      for (const listener of listeners)
        listener({
          kind: "engagement",
          state,
          targetId: 7,
          targetDistance: 6,
          execution: execution.snapshot(0),
          outcome: state === "ended" ? "died" : null,
          observation: null,
        });
    }
    const read = runtime.actions.find((action) => action.name === "read_recent_events")!;
    const history = readRecentEventsResultSchema.parse((await runtime.run(read, {})).result);
    const engagement = z.object({
      kind: z.literal("engagement"),
      state: z.string(),
      execution: combatExecutionSnapshotSchema,
    });
    assert.equal(history.events.length, 0, "internal combat decisions must not become notifications");
    const capture = await runtime.captureIncident();
    assert.equal(capture.kind, "completed");
    if (capture.kind !== "completed" || capture.reference.artifact.kind !== "written") throw new Error("Missing incident");
    const saved = (await readFile(capture.reference.artifact.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const engagements = saved.flatMap((record) => {
      if (record.kind !== "combat_decision") return [];
      const parsed = engagement.safeParse(record.event);
      return parsed.success ? [parsed.data] : [];
    });
    assert.deepEqual(
      engagements.map((event) => event.state),
      ["started", "waiting", "ended"],
    );
    assert.equal(new Set(engagements.map((event) => event.execution.progress.engagementId)).size, 1);
    assert.ok(engagements.every((event) => typeof event.execution.progress.inactiveMs === "number"));
    await runtime.flushIncidents();
  } finally {
    await runtime.close();
  }
  assert.equal(listeners.size, 0);
});

test("Mineflayer end captures the foreground request and still fails a nonsettling call", async (t) => {
  const bot = runtimeBot();
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-runtime-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await createMinecraftRuntime(bot, {
    incidents: { directory },
    botData: temporaryStorage("disconnect-test"),
    createCombatController: () => fakeCombat,
  });
  try {
    const query = runtime.actions.find((action) => action.name === "query_bot_data");
    assert.ok(query);
    assert.equal(query.begin, undefined);
    const requestId = runtime.recordActionRequest({
      actionName: query.name,
      rationale: "Prove disconnect correlation",
      requestedAt: new Date().toISOString(),
      request: {},
    });
    const entered = deferred();
    const pending = runtime.run(
      {
        ...query,
        execution: { kind: "task" },
        execute: async () => {
          entered.resolve();
          return new Promise<never>(() => {});
        },
      },
      { sql: "SELECT 1" },
      undefined,
      requestId,
    );
    await entered.promise;
    // An information call can overlap the foreground request without owning its incident.
    const informationId = runtime.recordActionRequest({
      actionName: query.name,
      rationale: "Observe during work",
      requestedAt: new Date().toISOString(),
      request: {},
    });
    assert.equal((await runtime.run(query, { sql: "SELECT 1" }, undefined, informationId)).result.status, "succeeded");
    assert.deepEqual(runtime.readRequestIncidents(informationId), []);
    bot.emit("physicsTick");
    bot.emit("end", "socketClosed");
    const output = await pending;
    assert.equal(output.result.status, "failed");
    assert.match(output.result.error ?? "", /MINECRAFT_DISCONNECTED.*socketClosed/);
    await runtime.flushIncidents();
    const incidents = runtime.readRequestIncidents(requestId);
    assert.equal(incidents[0]?.requestId, requestId);
    assert.equal(incidents[0]?.trigger, "disconnect");
    assert.equal(incidents[0]?.artifact.kind, "written");
    if (incidents[0]?.artifact.kind === "written") {
      assert.match(await readFile(incidents[0].artifact.path, "utf8"), /"kind":"physics"/);
    }
    assert.equal(runtime.status().busy, false);
    assert.equal((await runtime.run(query, { sql: "SELECT 1" })).result.status, "failed");
  } finally {
    await runtime.close();
  }
  assert.equal(bot.listenerCount("end"), 0);
});

test("an artifact write failure remains evidence and does not turn successful gameplay into failure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-runtime-write-test-"));
  const occupied = path.join(directory, "occupied");
  await writeFile(occupied, "not a directory");
  const bot = runtimeBot();
  const runtime = await createMinecraftRuntime(bot, {
    incidents: { directory: occupied },
    createCombatController: () => fakeCombat,
    botData: temporaryStorage("write-failure", "RuntimeBot"),
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const query = runtime.actions.find((action) => action.name === "query_bot_data");
  assert.ok(query);
  assert.equal(query.begin, undefined);
  const requestId = runtime.recordActionRequest({
    actionName: query.name,
    rationale: "Check persistence failure",
    requestedAt: new Date().toISOString(),
    request: {},
  });
  const output = await runtime.run(
    {
      ...query,
      execution: { kind: "task" },
      execute: async (request, context) => {
        bot._client.emit("damage_event", {
          entityId: 5,
          sourceTypeId: 2,
          sourceCauseId: 0,
          sourceDirectId: 0,
          sourcePosition: null,
        });
        bot.health = 18;
        bot.emit("health");
        return query.execute(request, context);
      },
    },
    { sql: "SELECT 1" },
    undefined,
    requestId,
  );
  assert.equal(output.result.status, "succeeded");
  await runtime.flushIncidents();
  const incidents = runtime.readRequestIncidents(requestId);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.artifact.kind, "failed");
  const reader = runtime.actions.find((action) => action.name === "read_recent_events");
  assert.ok(reader);
  const page = readRecentEventsResultSchema.parse((await runtime.run(reader, {})).result);
  assert.equal(page.events.length, 0, "ownership bookkeeping is not a notification");
  assert.equal(runtime.status().incidents.writeFailures, 1);
});

test("the Minecraft runtime owns frontier attachment and its action catalog", async () => {
  const controlStates: boolean[] = [];
  const bot = runtimeBot(controlStates);
  const runtime = await createMinecraftRuntime(bot, {
    botData: temporaryStorage("runtime-test"),
    createCombatController: () => fakeCombat,
  });

  // Which observers attach is each observer's own business; the runtime's is
  // that they attach here and that close detaches every one (below).
  const attached = ["chunkColumnLoad", "chunkColumnUnload", "blockUpdate", "physicsTick", "chat", "whisper", "death"] as const;
  for (const eventName of attached) assert.ok(bot.listenerCount(eventName) > 0, eventName);
  // The catalog is published whole: every action has a distinct name and its schemas.
  const names = runtime.actions.map((action) => action.name);
  assert.equal(new Set(names).size, names.length, "action names are distinct");
  for (const action of runtime.actions) {
    assert.ok(action.inputSchema && action.outputSchema, `${action.name} publishes its schemas`);
  }
  assert.ok(names.includes("query_bot_data") && names.includes("send_message"));
  // Incident counters are the recorder's to prove.
  const { survivalPolicy, survival, incidents: _incidents, ...runtimeStatus } = runtime.status();
  assert.deepEqual(survivalPolicy.overrides, []);
  assert.deepEqual(survival.policy, survivalPolicy);
  assert.deepEqual(
    runtimeStatus,
    {
      foreground: { active: null, awaitingResult: null, storageError: null },
      combat: null,
      busy: false,
      activeAction: null,
      owner: "idle",
      frontier: { observedChunks: 0, pendingChunks: 0, error: null },
      botData: { persistence: "temporary", scope: "bot", file: null, diagnostics: runtime.status().botData.diagnostics },
    },
  );
  assert.deepEqual(runtime.notificationSummary(), { unreadCount: 0 });

  // Every query an action declares is published under an action the catalog holds.
  const queryAction = runtime.actions.find((action) => action.name === "query_bot_data");
  assert.ok(queryAction);
  const catalog = await runtime.run(queryAction, {
    sql: "SELECT DISTINCT action_name FROM knowledge.action_queries",
  });
  const declared = catalog.result as unknown as { status: string; query: { rows: string[][] } };
  assert.equal(declared.status, "succeeded");
  const declaring = declared.query.rows.map(([name]) => name);
  assert.ok(declaring.length > 0);
  for (const name of declaring) assert.ok(names.includes(name!), name);

  bot.emit("chat", "Alex", "Hello RuntimeBot", null, {} as never, null);
  assert.deepEqual(runtime.notificationSummary(), {
    unreadCount: 1,
    recentPreview: ["Alex: Hello RuntimeBot"],
    hint: "Use read_recent_events to read and advance through recent events.",
  });

  const sendMessageAction = runtime.actions.find((action) => action.name === "send_message");
  assert.ok(sendMessageAction);
  const sent = await runtime.run(sendMessageAction, { message: "Hello Alex" });
  assert.deepEqual(sent.result, { status: "succeeded", message: "Hello Alex" });
  assert.deepEqual(runtime.notificationSummary(), {
    unreadCount: 1,
    recentPreview: ["Alex: Hello RuntimeBot"],
    hint: "Use read_recent_events to read and advance through recent events.",
  });

  Object.assign(bot.entity, { isInWater: true });
  bot.emit("physicsTick");
  assert.deepEqual(controlStates, [true]);

  const close = runtime.close();
  assert.equal(runtime.close(), close);
  assert.equal(runtime[Symbol.asyncDispose](), close);
  await close;
  for (const eventName of attached) assert.equal(bot.listenerCount(eventName), 0, eventName);
  assert.deepEqual(controlStates, [true, false]);
});

test("runtime creation settles every acquired attachment before rejecting", async () => {
  const bot = runtimeBot([], "physicsTick");

  await assert.rejects(
    createMinecraftRuntime(bot, {
      botData: temporaryStorage("runtime-startup-failure-test"),
    }),
    /Listener registration failed for physicsTick/,
  );

  for (const eventName of [
    "chunkColumnLoad",
    "chunkColumnUnload",
    "blockUpdate",
    "physicsTick",
    "chat",
    "whisper",
    "death",
    "spawn",
  ] as const) {
    assert.equal(bot.listenerCount(eventName), 0, eventName);
  }
  assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
});

test("death cancels the foreground action, records one event, and permits work after respawn", async (t) => {
  const bot = runtimeBot();
  bot.chat = () => undefined;
  const runtime = await createMinecraftRuntime(bot, {
    botData: temporaryStorage("death-runtime-test", "RuntimeBot"),
    createCombatController: () => fakeCombat,
  });
  t.after(() => runtime.close());

  const sendMessageAction = runtime.actions.find((action) => action.name === "send_message");
  const readEventsAction = runtime.actions.find((action) => action.name === "read_recent_events");
  assert.ok(sendMessageAction);
  assert.ok(readEventsAction);

  const running = runtime.run(sendMessageAction, { message: "This will be interrupted" });
  assert.equal(runtime.status().busy, true);
  bot.emit("death");

  assert.deepEqual((await running).result, {
    kind: "runtime_failure",
    status: "cancelled",
    error: "RuntimeBot died.",
  });
  assert.equal(runtime.status().busy, false);

  const events = await runtime.run(readEventsAction, {});
  const eventPage = readRecentEventsResultSchema.parse(events.result);
  assert.equal(eventPage.status, "succeeded");
  // The event's content is the player-event observer's to prove; here, only
  // that the runtime wired it to this bot's store.
  assert.equal(eventPage.events.filter((event) => event.type === "player_death").length, 1);

  bot.chat = (message) => bot.emit("chat", bot.username, message, null, {} as never, null);
  assert.deepEqual((await runtime.run(sendMessageAction, { message: "Work resumed" })).result, {
    status: "succeeded",
    message: "Work resumed",
  });
});

test("adds unrestricted JavaScript execution only to an explicitly debug-enabled runtime", async () => {
  const runtime = await createMinecraftRuntime(runtimeBot(), {
    botData: temporaryStorage("debug-runtime-test", "debug-runtime-bot"),
    debugExecuteJavaScript: true,
    createCombatController: () => fakeCombat,
  });

  assert.deepEqual(
    runtime.actions.slice(-2).map((action) => action.name),
    ["debug_set_pathfinder_telemetry", "debug_execute_javascript"],
  );
  await runtime.close();
});

test("recent calls are published with their own arguments and rationale, then their outcome", async (t) => {
  const runtime = await createMinecraftRuntime(runtimeBot(), {
    createCombatController: () => fakeCombat,
    botData: temporaryStorage("latest-call", "RuntimeBot"),
  });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.recentCalls(), []);
  const requestId = runtime.recordActionRequest({
    actionName: "navigate",
    rationale: "Walk to the village",
    requestedAt: "2026-09-08T12:00:00.000Z",
    request: { x: 10, y: 64, z: -3, rationale: "Walk to the village", response_format: "markdown" },
  });
  assert.deepEqual(runtime.recentCalls(), [{
    requestId,
    action: "navigate",
    arguments: { x: 10, y: 64, z: -3 },
    rationale: "Walk to the village",
    requestedAt: "2026-09-08T12:00:00.000Z",
    status: null,
    respondedAt: null,
    durationMs: null,
  }]);
  runtime.recordActionResponse({
    requestId,
    respondedAt: "2026-09-08T12:00:05.000Z",
    durationMs: 5000,
    status: "succeeded",
    response: {},
  });
  assert.equal(runtime.recentCalls()[0]?.status, "succeeded");
  assert.equal(runtime.recentCalls()[0]?.durationMs, 5000);
});

test("recent calls keep the newest first and stay bounded", async (t) => {
  const runtime = await createMinecraftRuntime(runtimeBot(), {
    createCombatController: () => fakeCombat,
    botData: temporaryStorage("recent-calls", "RuntimeBot"),
  });
  t.after(() => runtime.close());
  for (let call = 0; call < 12; call++) {
    runtime.recordActionRequest({
      actionName: `navigate_${call}`,
      rationale: "Keep walking",
      requestedAt: "2026-09-08T12:00:00.000Z",
      request: { rationale: "Keep walking" },
    });
  }
  const calls = runtime.recentCalls();
  assert.equal(calls.length, 8);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["navigate_11", "navigate_10", "navigate_9", "navigate_8", "navigate_7", "navigate_6", "navigate_5", "navigate_4"],
  );
});
