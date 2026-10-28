import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { SqlBotData } from "../../bot-data/index.js";
import type { Navigate, NavigationResult, NavigationRuntime } from "../../navigation/index.js";
import type { FrontierChunk, SessionFrontier } from "../../bot-data/frontier.js";
import { ActionRunner } from "../../runner/action-runner.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { headingForVector, parseExploreFrontierRequest, unitVectorForHeading } from "./contract.js";
import {
  beginExploreFrontier,
  createExploreFrontierAction,
  formatExploreFrontierResult,
  exploreFrontier,
} from "./explore-frontier.js";

interface TestFrontier extends SessionFrontier {
  record(chunk: FrontierChunk): void;
  setBoundary(boundary: number): void;
  setError(error: string | null): void;
  listenerCount(): number;
}

function frontierFixture(initialBoundary = 0): TestFrontier {
  let currentBoundary = initialBoundary;
  let error: string | null = null;
  let observedChunks = 1;
  const listeners = new Set<(chunk: FrontierChunk) => void>();
  const close = () => listeners.clear();
  return {
    status: () => ({ observedChunks, pendingChunks: 0, error }),
    idle: async () => {},
    boundary: () => currentBoundary,
    onRecorded: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
    [Symbol.dispose]: close,
    record: (chunk) => {
      observedChunks += 1;
      for (const listener of listeners) listener(chunk);
    },
    setBoundary: (next) => {
      currentBoundary = next;
    },
    setError: (next) => {
      error = next;
    },
    listenerCount: () => listeners.size,
  };
}

/** A bot standing at the origin, with what body preparation before a foreground action touches. */
function explorer() {
  const bot = botFixture(
    { position: { x: 0, y: 64, z: 0 } },
    { clearControlStates: () => undefined, deactivateItem: () => undefined },
  );
  return { bot };
}

function completedNavigation(): NavigationResult {
  return { status: "completed", elapsedMs: 1 };
}

function stoppedNavigation(reason = "No path to the goal"): NavigationResult {
  return { status: "stopped", reason, elapsedMs: 1 };
}

/** The navigation runtime as exploration sees it: the leg it is handed, and a cancel for body preparation. */
function navigationWith(navigate: Navigate): NavigationRuntime {
  return { navigate, cancel: () => undefined } as unknown as NavigationRuntime;
}

/** A grounded bot whose loaded column reports `biomeAt(feet)` by the connection's registry id. */
function biomeBotFixture(biomeAt: (feet: Vec3) => string) {
  const { bot } = explorer();
  bot.world = {
    ...bot.world,
    getColumnAt: () => ({}),
    getBiome: (feet: Vec3) => registry.biomesByName[biomeAt(feet) === "warped_forest" ? "warped_forest" : "plains"]!.id,
  } as unknown as Bot["world"];
  return bot;
}

test("biome entry stops an active leg at the observed three-dimensional feet position", async () => {
  const bot = biomeBotFixture((feet) => (feet.x >= 5 && feet.y === 64 ? "warped_forest" : "plains"));
  const frontier = frontierFixture();
  let calls = 0;
  const navigation = navigationWith(async ({ stopSignal }) => {
    calls++;
    assert.equal(stopSignal?.aborted, false);
    bot.entity.position = new Vec3(5.3, 64, 0.5);
    bot.entity.onGround = false;
    bot.emit("physicsTick");
    assert.equal(stopSignal?.aborted, false, "airborne entry must retain movement until landing");
    bot.entity.onGround = true;
    bot.emit("physicsTick");
    assert.equal(stopSignal?.aborted, true);
    return stoppedNavigation(String(stopSignal?.reason));
  });
  const result = await exploreFrontier(
    bot,
    { heading: 90, chunks: 2, biome: "warped_forest" },
    {},
    frontier,
    navigation,
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.explored.biome, {
    status: "entered",
    name: "warped_forest",
    position: { x: 5, y: 64, z: 0 },
  });
  assert.equal(result.explored.expandedChunks, 0);
  assert.equal(calls, 1);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(frontier.listenerCount(), 0);
});

test("an already entered target needs no expansion and unknown names fail without movement", async () => {
  const bot = biomeBotFixture(() => "warped_forest");
  const navigation = navigationWith(async () => {
    throw new Error("must not navigate");
  });
  const already = await exploreFrontier(
    bot,
    { heading: 90, chunks: 1, biome: "warped_forest" },
    {},
    frontierFixture(),
    navigation,
  );
  assert.equal(already.status, "succeeded");
  assert.equal(already.explored.expandedChunks, 0);
  const unknown = await exploreFrontier(
    bot,
    { heading: 90, chunks: 1, biome: "typo" },
    {},
    frontierFixture(),
    navigation,
  );
  assert.equal(unknown.status, "failed");
  assert.match("error" in unknown ? unknown.error : "", /EXPLORATION_UNKNOWN_BIOME/);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("exhausting the existing boundary expansion without biome entry is partial", async () => {
  // A biome above the bot does not establish entry at its feet.
  const bot = biomeBotFixture((feet) => (feet.y > 64 ? "warped_forest" : "plains"));
  const frontier = frontierFixture();
  const navigation = navigationWith(async () => {
    bot.entity.position.x = 16;
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
    bot.emit("physicsTick");
    return completedNavigation();
  });
  const result = await exploreFrontier(
    bot,
    { heading: 90, chunks: 1, biome: "warped_forest" },
    {},
    frontier,
    navigation,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.explored.expandedChunks, 1);
  assert.deepEqual(result.explored.biome, { status: "not_observed", name: "warped_forest" });
  assert.match("error" in result ? result.error : "", /EXPLORATION_BIOME_NOT_OBSERVED/);
});

test("cancellation with a biome target retains runtime cancellation and releases observation", async () => {
  const bot = biomeBotFixture(() => "plains");
  const frontier = frontierFixture();
  const controller = new AbortController();
  const navigation = navigationWith(async () => {
    controller.abort("cancel biome search");
    controller.signal.throwIfAborted();
    return completedNavigation();
  });
  await assert.rejects(
    exploreFrontier(
      bot,
      { heading: 90, chunks: 1, biome: "warped_forest" },
      { signal: controller.signal },
      frontier,
      navigation,
    ),
  );
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(frontier.listenerCount(), 0);
});

test("resolves degree headings to unit vectors and back", () => {
  assert.equal(headingForVector(0, -1), 0);
  assert.equal(headingForVector(1, 0), 90);
  assert.equal(headingForVector(0, 1), 180);
  assert.equal(headingForVector(-1, 0), 270);
  assert.equal(headingForVector(1, -1), 45);

  const north = unitVectorForHeading(0);
  assert.equal(Math.round(north.x), 0);
  assert.equal(Math.round(north.z), -1);

  const east = unitVectorForHeading(90);
  assert.equal(Math.round(east.x), 1);
  assert.equal(Math.round(east.z), 0);
});

test("extends the requested boundary through short legs while pricing exploration scaffolds", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  let calls = 0;
  const runRoute: Navigate = async (options) => {
    assert.equal(options.timeoutMs, undefined, "terrain work must not be cut off by a per-leg clock");
    // Exploration prices scaffolding high so a leg walks round a gap it could
    // bridge, keeping carried blocks for the terrain that needs them.
    assert.equal(options.movements.placementPenalty, 80);
    calls += 1;
    assert.ok("goal" in options);
    const expectedX = calls * 16;
    const snapshot = options.goal.resolve({} as never);
    assert.equal(
      snapshot.kind === "active" ? snapshot.revision : "invalid",
      `advance:${bot.entity.position.x.toFixed(1)},${bot.entity.position.z.toFixed(1)}>1.000,0.000:16`,
    );
    bot.entity.position = new Vec3(expectedX, 64, 0);
    frontier.record({ dimension: "overworld", chunkX: calls, chunkZ: calls === 1 ? 5 : -3 });
    return completedNavigation();
  };
  const navigation = navigationWith(runRoute);
  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 2 }),
    {},
    frontier,
    navigation,
  );

  assert.deepEqual(result, {
    status: "succeeded",
    explored: {
      dimension: "overworld",
      heading: 90,
      requestedChunks: 2,
      expandedChunks: 2,
      newChunksRecorded: 2,
      start: { x: 0, y: 64, z: 0 },
      end: { x: 32, y: 64, z: 0 },
      nearestFrontier: null,
    },
    source: { queryIds: ["frontier-nearest"] },
  });
  assert.equal(calls, 2);
  assert.equal(frontier.listenerCount(), 0);
  assert.match(formatExploreFrontierResult(result), /Expanded \*\*2\/2\*\*/);
  assert.match(formatExploreFrontierResult(result), /End: `32, 64, 0`/);
});

test("explores with botData and populates nearestFrontier from frontier_navigation view", async (t) => {
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "nav-test", scope: { kind: "bot", botId: "bot1" } },
  });
  t.after(() => data.close());

  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction, is_frontier
        ) VALUES ('overworld|3|0', 'overworld', 3, 0, '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:01.000Z', 0, 1)`,
      )
      .run();
  });

  const frontier = frontierFixture();
  const { bot } = explorer();
  const runRoute: Navigate = async () => {
    bot.entity.position = new Vec3(16, 64, 0);
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
    return completedNavigation();
  };
  const navigation = navigationWith(runRoute);
  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 1 }),
    {},
    frontier,
    navigation,
    data,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.source, { queryIds: ["frontier-nearest"] });
  assert.deepEqual(result.explored.nearestFrontier, {
    chunkX: 3,
    chunkZ: 0,
    distanceBlocks: 40.8,
    heading: 101.3,
  });
});

test("explores a diagonal as one normalized direction", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const runRoute: Navigate = async (options) => {
    assert.ok("goal" in options);
    const expectedX = Math.floor(16 / Math.sqrt(2));
    const expectedZ = Math.floor(-16 / Math.sqrt(2));
    const snapshot = options.goal.resolve({} as never);
    assert.equal(
      snapshot.kind === "active" ? snapshot.revision : "invalid",
      `advance:${bot.entity.position.x.toFixed(1)},${bot.entity.position.z.toFixed(1)}>0.707,-0.707:16`,
    );
    bot.entity.position = new Vec3(expectedX, 64, expectedZ);
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: -1 });
    return completedNavigation();
  };
  const navigation = navigationWith(runRoute);

  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 45 }),
    {},
    frontier,
    navigation,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.explored.heading, 45);
  assert.equal(result.explored.expandedChunks, 1);
});

test("late spawn-ring commits cannot settle exploration without forward travel", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  let calls = 0;
  const runRoute: Navigate = async () => {
    calls += 1;
    if (calls === 1) {
      frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
      bot.entity.position = new Vec3(0.8, 64, 0);
      return completedNavigation();
    }
    bot.entity.position = new Vec3(16, 64, 0);
    return completedNavigation();
  };
  const navigation = navigationWith(runRoute);

  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 1 }),
    {},
    frontier,
    navigation,
  );

  assert.equal(calls, 2);
  assert.equal(result.status, "succeeded");
  assert.equal(result.explored.expandedChunks, 1);
  assert.deepEqual(result.explored.end, { x: 16, y: 64, z: 0 });
});

test("side chunks are recorded without manufacturing directional progress", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const runRoute: Navigate = async () => {
    frontier.record({ dimension: "overworld", chunkX: 0, chunkZ: 8 });
    frontier.record({ dimension: "overworld", chunkX: 0, chunkZ: -8 });
    return stoppedNavigation();
  };
  const navigation = navigationWith(runRoute);
  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 1 }),
    {},
    frontier,
    navigation,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.explored.expandedChunks, 0);
  assert.equal(result.explored.newChunksRecorded, 2);
  assert.match("error" in result ? result.error : "", /EXPLORATION_ROUTE_STOPPED/);
});

test("another bot's shared write cannot settle this action", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const runRoute: Navigate = async () => {
    frontier.setBoundary(20);
    return stoppedNavigation();
  };
  const navigation = navigationWith(runRoute);
  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 1 }),
    {},
    frontier,
    navigation,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.explored.expandedChunks, 0);
  assert.equal(result.explored.newChunksRecorded, 0);
});

test("reports partial progress when navigation stops after one boundary column", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const runRoute: Navigate = async () => {
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
    bot.entity.position = new Vec3(16, 64, 0);
    return stoppedNavigation("stuck");
  };
  const navigation = navigationWith(runRoute);
  const result = await exploreFrontier(
    bot,
    parseExploreFrontierRequest({ heading: 90, chunks: 2 }),
    {},
    frontier,
    navigation,
  );

  assert.equal(result.status, "partial");
  assert.equal(result.explored.expandedChunks, 1);
  assert.match("error" in result ? result.error : "", /EXPLORATION_ROUTE_STOPPED.*stuck/);
});

test("caller cancellation remains a runtime outcome and always cleans up", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const controller = new AbortController();
  const runRoute: Navigate = async () => {
    controller.abort("test cancellation");
    throw new Error("test cancellation");
  };
  const navigation = navigationWith(runRoute);
  const action = createExploreFrontierAction(bot, navigation, frontier);
  const runner = new ActionRunner();

  const output = await runner.run(action, { heading: 90, chunks: 2 }, controller.signal);

  assert.equal(output.result.status, "cancelled");
  assert.equal(frontier.listenerCount(), 0);
});

test("a resumed request retains its original frontier target and cumulative own observations", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  let calls = 0;
  let announceStart = () => {};
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const navigation = navigationWith(async ({ signal }) => {
    calls++;
    bot.entity.position.x += 16;
    frontier.record({ dimension: "overworld", chunkX: calls === 3 ? 21 : calls, chunkZ: 0 });
    if (calls === 1) {
      frontier.setBoundary(1);
      announceStart();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      signal?.throwIfAborted();
    }
    return completedNavigation();
  });
  const action = createExploreFrontierAction(bot, navigation, frontier);
  const runner = new ActionRunner();
  const pending = runner.run(action, { heading: 90, chunks: 2 });
  await started;
  const claim = runner.claim("hostile_reflex", "fight finished", async () => {
    assert.equal(frontier.listenerCount(), 0, "the paused attempt owns no subscription");
    frontier.record({ dimension: "overworld", chunkX: 10, chunkZ: 0 });
    frontier.setBoundary(20);
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  assert.equal(output.result.status, "succeeded");
  assert.ok("explored" in output.result);
  assert.deepEqual(output.result.explored.start, { x: 0, y: 64, z: 0 });
  assert.equal(output.result.explored.expandedChunks, 2);
  assert.equal(
    output.result.explored.newChunksRecorded,
    2,
    "takeover records and shared writes are not action observations",
  );
  assert.equal(calls, 2);
  assert.equal(frontier.listenerCount(), 0);
  assert.deepEqual(output.interruptions, ["fight finished"]);

  const next = await runner.run(action, { heading: 90, chunks: 1 });
  assert.equal(next.result.status, "succeeded");
  assert.ok("explored" in next.result);
  assert.deepEqual(next.result.explored.start, { x: 32, y: 64, z: 0 });
  assert.equal(next.result.explored.expandedChunks, 1);
  assert.equal(next.result.explored.newChunksRecorded, 1, "a new admitted request has fresh evidence");
});

test("an interrupted attempt that already expanded the requested column needs no replacement leg", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const interrupted = new AbortController();
  let calls = 0;
  const navigation = navigationWith(async () => {
    calls++;
    bot.entity.position.x = 16;
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
    interrupted.abort("reflex takeover");
    return completedNavigation();
  });
  const execute = beginExploreFrontier(bot, { heading: 90, chunks: 1 }, frontier, navigation);
  await assert.rejects(execute({ signal: interrupted.signal }));
  assert.equal(frontier.listenerCount(), 0);
  bot.entity.position.x = 0;
  const result = await execute({ signal: new AbortController().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.explored.expandedChunks, 1);
  assert.equal(result.explored.newChunksRecorded, 1);
  assert.equal(calls, 1);
});

test("resumption in another dimension settles the original expansion without another leg", async () => {
  const frontier = frontierFixture();
  const { bot } = explorer();
  const interrupted = new AbortController();
  let calls = 0;
  const navigation = navigationWith(async () => {
    calls++;
    bot.entity.position.x = 16;
    frontier.record({ dimension: "overworld", chunkX: 1, chunkZ: 0 });
    interrupted.abort("reflex takeover");
    return completedNavigation();
  });
  const execute = beginExploreFrontier(bot, { heading: 90, chunks: 2 }, frontier, navigation);
  await assert.rejects(execute({ signal: interrupted.signal }));
  bot.game.dimension = "the_nether";
  const result = await execute({});
  assert.equal(result.status, "partial");
  assert.equal(result.explored.dimension, "overworld");
  assert.equal(result.explored.expandedChunks, 1);
  assert.equal(result.explored.newChunksRecorded, 1);
  assert.match("error" in result ? result.error : "", /DIMENSION/);
  assert.equal(calls, 1);
  assert.equal(frontier.listenerCount(), 0);
});
