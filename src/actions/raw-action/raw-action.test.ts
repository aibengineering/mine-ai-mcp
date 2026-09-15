import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { botFixture } from "../../test-support/bot.js";
import { executeRawAction } from "./raw-action.js";
import { parseRawActionRequest, rawActionInputSchema } from "./contract.js";

test("parses each operation into a small discriminated request and rejects mixed fields", () => {
  assert.deepEqual(
    parseRawActionRequest({ operation: "control", state: "jump", ticks: 40 }),
    { operation: "control", state: "jump", ticks: 40 },
  );
  assert.deepEqual(
    parseRawActionRequest({ operation: "look", x: 1, y: 2, z: 3 }),
    { operation: "look", target: { x: 1, y: 2, z: 3 }, yaw: null, pitch: null },
  );
  assert.throws(
    () =>
      parseRawActionRequest({ operation: "dig", x: 1, y: 2, z: 3, ticks: 2 }),
    /ticks is not used by dig/,
  );
  assert.throws(
    () =>
      parseRawActionRequest({ operation: "control", state: "jump", ticks: 41 }),
    /<=40/,
  );
});

test("operation checks ignore server-owned metadata while standalone input stays strict", () => {
  const serverInput = rawActionInputSchema.safeExtend({
    submission_id: z.string(),
    rationale: z.string(),
    response_format: z.enum(["markdown", "json"]),
  });
  assert.deepEqual(
    serverInput.parse({
      operation: "look",
      yaw: 0,
      pitch: 0,
      submission_id: "raw-look-1",
      rationale: "Look toward the target",
      response_format: "json",
    }),
    {
      operation: "look",
      yaw: 0,
      pitch: 0,
      submission_id: "raw-look-1",
      rationale: "Look toward the target",
      response_format: "json",
    },
  );
  assert.throws(
    () =>
      serverInput.parse({
        operation: "look",
        yaw: 0,
        pitch: 0,
        ticks: 2,
        submission_id: "raw-look-2",
        rationale: "Look toward the target",
        response_format: "markdown",
      }),
    /ticks is not used by look/,
  );
  assert.throws(
    () =>
      rawActionInputSchema.parse({
        operation: "look",
        yaw: 0,
        pitch: 0,
        unknown: true,
      }),
    /Unrecognized key/,
  );
});

test("dig refuses beyond eye reach without calling Mineflayer", async () => {
  let digs = 0;
  const bot = botFixture(
    { position: new Vec3(0.5, 64, 0.5), blocks: { "8,64,0": "stone" } },
    {
      dig: async () => {
        digs++;
      },
    },
  );
  const result = await executeRawAction(
    bot,
    { operation: "dig", target: { x: 8, y: 64, z: 0 } },
    {},
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_OUT_OF_REACH/);
  assert.equal(digs, 0);
  assert.deepEqual(result.target, { x: 8, y: 64, z: 0 });
  assert.equal(result.beforeBlock, "stone");
  assert.equal(result.afterBlock, "stone");
});

test("dig success is based on the block observed after the native call", async () => {
  let present = true;
  const bot = botFixture(
    {
      position: new Vec3(0.5, 64, 0.5),
      blocks: (cell) =>
        cell.equals(new Vec3(1, 64, 0)) && present
          ? ({
              name: "pointed_dripstone",
              position: cell,
              boundingBox: "block",
              shapes: [[0, 0, 0, 1, 1, 1]],
            } as never)
          : ({
              name: "air",
              position: cell,
              boundingBox: "empty",
              shapes: [],
            } as never),
    },
    {
      dig: async () => {
        present = false;
      },
    },
  );
  const result = await executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    {},
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.beforeBlock, "pointed_dripstone");
  assert.equal(result.afterBlock, "air");
  assert.equal(result.attempted, true);
  assert.equal(result.effectObserved, true);
});

test("dig cancellation calls stopDigging and drains the native operation before returning ownership", async () => {
  const stop = new AbortController();
  let stopped = 0;
  let settle!: () => void;
  const native = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const bot = botFixture(
    { position: new Vec3(0.5, 64, 0.5), blocks: { "1,64,0": "stone" } },
    {
      dig: () => native,
      stopDigging: () => {
        stopped++;
        settle();
      },
    },
  );
  const running = executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    { signal: stop.signal },
  );
  stop.abort(new Error("operator cancelled dig"));
  await assert.rejects(running, /operator cancelled dig/);
  assert.equal(stopped, 1);
});

test("a native call that synchronously aborts is stopped and drained", async () => {
  const stop = new AbortController();
  let stopped = 0;
  const bot = botFixture(
    { position: new Vec3(0.5, 64, 0.5), blocks: { "1,64,0": "stone" } },
    {
      dig: () => { stop.abort(new Error("disconnect during dig start")); return Promise.resolve(); },
      stopDigging: () => { stopped++; },
    },
  );
  await assert.rejects(
    executeRawAction(bot, { operation: "dig", target: { x: 1, y: 64, z: 0 } }, { signal: stop.signal }),
    /disconnect during dig start/,
  );
  assert.equal(stopped, 1);
});

test("control releases when setting the state synchronously aborts", async () => {
  const stop = new AbortController();
  const states: Array<[string, boolean]> = [];
  const bot = botFixture({}, {
    setControlState: (state: string, active: boolean) => {
      states.push([state, active]);
      if (active) stop.abort(new Error("disconnect during control start"));
    },
  });
  await assert.rejects(
    executeRawAction(bot, { operation: "control", state: "jump", ticks: 10 }, { signal: stop.signal }),
    /disconnect during control start/,
  );
  assert.deepEqual(states, [["jump", true], ["jump", false]]);
});

test("dig does not treat an unloaded after-state as an observed block change", async () => {
  let read = 0;
  const stone = { name: "stone", position: new Vec3(1, 64, 0) };
  const bot = botFixture(
    { position: new Vec3(0.5, 64, 0.5) },
    {
      blockAt: () => (read++ === 0 ? stone : null),
      dig: async () => undefined,
    },
  );
  const result = await executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    {},
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_DIG_NOT_OBSERVED/);
  assert.equal(result.effectObserved, false);
});

test("control releases only its owned state when cancellation interrupts the tick wait", async () => {
  const states: Array<[string, boolean]> = [];
  const stop = new AbortController();
  const bot = botFixture(
    {},
    {
      setControlState: (state: string, active: boolean) =>
        states.push([state, active]),
    },
  );
  const running = executeRawAction(
    bot,
    { operation: "control", state: "forward", ticks: 40 },
    { signal: stop.signal },
  );
  stop.abort(new Error("operator cancelled"));
  await assert.rejects(running, /operator cancelled/);
  assert.deepEqual(states, [
    ["forward", true],
    ["forward", false],
  ]);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});
