import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import mineflayer, { type Bot } from "mineflayer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { SqlBotData } from "../bot-data/index.js";
import { botFixture, type BotFixtureOptions } from "../test-support/bot.js";
import { parseHostOptions } from "./config.js";
import type { OperatorNotices } from "./operator-notices.js";
import { startRuntimeHost } from "./runtime-host.js";

const source = { kind: "unavailable", reason: "Host lifecycle test" } as const;

/**
 * Host options over a data root removed when the test ends, and notices that
 * record, per stream, the readiness, connection and bot-data lifecycle lines
 * the host would have written for its operator.
 */
async function configuration(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-lifetime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = { stdout: [] as string[], stderr: [] as string[] };
  const notices: OperatorNotices = {
    stdout: (line) => output.stdout.push(line),
    stderr: (line) => output.stderr.push(line),
  };
  return { options: { ...parseHostOptions(["--data-root", directory]), listenPort: 0 }, notices, output };
}

/**
 * `startup` is what the fake server does once the bot exists; by default it
 * logs the bot in and spawns it.
 */
function connectedBot(
  t: TestContext,
  fixture: BotFixtureOptions = {},
  startup: (bot: Bot, client: EventEmitter) => void = (bot, client) => {
    client.emit("login", { worldState: { hashedSeed: 1n } });
    bot.emit("spawn");
  },
) {
  const client = Object.assign(new EventEmitter(), { uuid: "host-test", write: () => {} });
  const bot = botFixture(
    fixture,
    {
      _client: client,
      getControlState: () => false,
      clearControlStates: () => {},
      quit: () => bot.emit("end", "Host test closed"),
    },
  );
  Object.assign(bot.world, { getColumn: () => undefined });
  // Mineflayer indexes equipment by window slot; the fixture takes a record.
  const slots = new Array(46).fill(null);
  for (const [slot, item] of Object.entries(fixture.slots ?? {})) slots[Number(slot)] = item;
  bot.inventory.slots = slots;
  t.mock.method(mineflayer, "createBot", () => {
    queueMicrotask(() => startup(bot, client));
    return bot;
  });
  return bot;
}

function failures(error: unknown): unknown[] {
  return error instanceof SuppressedError ? [...failures(error.suppressed), ...failures(error.error)] : [error];
}

for (const inline of [false, true]) {
  test(`normal host publishes ${inline ? "explicit inline fallback" : "default reference"} output schemas`, async (t) => {
    const { options, notices } = await configuration(t);
    connectedBot(t);
    await using host = await startRuntimeHost(source, {
      ...options,
      outputSchemaReferences: parseHostOptions(inline ? ["--inline-output-schemas"] : []).outputSchemaReferences,
    }, notices);
    const address = host.server.address();
    assert.ok(address && typeof address === "object");
    const client = new Client({ name: "host-schema-contract", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    try {
      await client.connect(transport);
      // Compare actual host discovery without paying the legacy catalogue's
      // whole-client compilation cost. Validator integration lives in the
      // catalogue and async-tools tests.
      const catalogue = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      const wait = catalogue.tools.find((tool) => tool.name === "wait_for_action")!.outputSchema!;
      const bytes = Buffer.byteLength(JSON.stringify(wait));
      if (inline) assert.ok(bytes > 800_000, "the fallback must reach every normal-host protocol session");
      else assert.ok(bytes < 200_000, "normal-host sessions must use compact schemas by default");
      await transport.terminateSession();
    } finally {
      await client.close();
    }
  });
}

test("a startup failure after the bot observers are installed still quits the bot and releases them", async (t) => {
  const { options, notices } = await configuration(t);
  // Spawning without the login packet is a startup failure the host detects
  // only after `loadBotPlugins` has attached its registry observer.
  const bot = connectedBot(t, {}, (bot) => bot.emit("spawn"));
  const quit = t.mock.method(bot, "quit");
  await assert.rejects(startRuntimeHost(source, options, notices), /spawned before supplying its login packet/);
  assert.equal(quit.mock.callCount(), 1);
  assert.equal(bot._client.listenerCount("registry_data"), 0);
});

test("failed HTTP binding releases the runtime and bot and retains combined cleanup failures", async (t) => {
  const { options, notices } = await configuration(t);
  const bot = connectedBot(t);
  await using occupied = createServer();
  await once(occupied.listen(0, "127.0.0.1"), "listening");
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const runtimeFailure = new Error("Runtime disposal failed");
  const quitFailure = new Error("Bot quit failed");
  const closeDatabase = SqlBotData.prototype.close;
  const releases: string[] = [];
  t.mock.method(SqlBotData.prototype, "close", function (this: SqlBotData) {
    closeDatabase.call(this);
    releases.push("database");
    throw runtimeFailure;
  });
  t.mock.method(bot, "quit", () => {
    releases.push("bot");
    assert.equal(
      EventEmitter.prototype.listenerCount.call(bot, "path_update"),
      0,
      "The highlighter releases before bot.quit.",
    );
    bot.emit("end", "Host test closed");
    throw quitFailure;
  });
  await assert.rejects(startRuntimeHost(source, { ...options, listenPort: address.port }, notices), (error) => {
    const causes = failures(error);
    assert.ok(causes.some((cause) => cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE"));
    assert.ok(causes.includes(runtimeFailure));
    assert.ok(causes.includes(quitFailure));
    return true;
  });
  assert.deepEqual(releases, ["database", "bot"]);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("error"), 0);
});

test(
  "host disposal drains MCP streams before HTTP, runtime and bot, and concurrent close shares completion",
  { timeout: 10_000 },
  async (t) => {
    const { options, notices, output } = await configuration(t);
    const bot = connectedBot(t);
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await using host = await startRuntimeHost(source, options, notices);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
    const address = host.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const initialize = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "lifetime-test", version: "1" },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    await initialize.text();
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const stream = await fetch(`${url}/mcp`, {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
    });
    assert.equal(stream.status, 200);
    const streamClosed = stream.text();
    const closeDatabase = SqlBotData.prototype.close;
    const releases: string[] = [];
    t.mock.method(SqlBotData.prototype, "close", function (this: SqlBotData) {
      assert.equal(host.server.listening, false);
      closeDatabase.call(this);
      releases.push("database");
    });
    t.mock.method(bot, "quit", () => {
      releases.push("bot");
      assert.equal(bot.listenerCount("physicsTick"), 0);
      bot.emit("end", "Host test closed");
    });
    bot.emit("end", "Connection lost during test");
    assert.equal((await fetch(`${url}/health`)).status, 503);
    assert.equal(host.server.listening, true, "Disconnect keeps HTTP available to report failures.");
    const closed = host.close();
    assert.equal(host.close(), closed);
    await closed;
    await streamClosed;
    assert.deepEqual(releases, ["database", "bot"]);
    assert.equal(
      output.stderr.filter((line) => line.includes("Minecraft connection ended: Connection lost during test")).length,
      1,
      "The operator is told why the runtime stopped serving.",
    );
  },
);

test("health publishes the bot's own slots and the calls an observer cannot otherwise see", async (t) => {
  const { options, notices } = await configuration(t);
  connectedBot(t, {
    items: [{ name: "cobblestone", count: 12, slot: 36 }],
    slots: { 5: { name: "iron_helmet", count: 1 } },
  });
  await using host = await startRuntimeHost(source, options, notices);
  const address = host.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  const health = await (await fetch(`${url}/health`)).json();
  // A Minecraft client is sent only another player's six equipment slots, so
  // the worn helmet and the carried stack can come only from this endpoint.
  assert.deepEqual(health.minecraft.inventory, [
    { slot: 5, location: "head", name: "iron_helmet", count: 1, held: false, durability: null },
    { slot: 36, location: "hotbar", name: "cobblestone", count: 12, held: true, durability: null },
  ]);
  assert.deepEqual(health.minecraft.recentCalls, []);
});
