import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { parseHuntMobRequest } from "./contract.js";
import { SpawnerCamp } from "./spawner-camp.js";

function fixture(waitMs = 15) {
  let name = "spawner";
  const bot = botFixture(
    { position: new Vec3(20.5, 64, 0.5) },
    {
      blockAt: (position: Vec3) => ({ name, position }),
    },
  );
  let routes = 0;
  const camp = new SpawnerCamp(bot, new Vec3(0, 64, 0), waitMs, async (position) => {
    routes++;
    bot.entity.position = position.offset(1.5, 0, 0.5);
    return { status: "completed", elapsedMs: 1 };
  });
  return {
    bot,
    camp,
    routes: () => routes,
    destroy: () => {
      name = "air";
      bot.emit("blockUpdate", null, bot.blockAt(new Vec3(0, 64, 0))!);
    },
  };
}

test("normal hunting defaults to no wait; camping requires explicit finite patience", () => {
  const input = { mob_name: "blaze", drop_name: "blaze_rod" };
  assert.equal(parseHuntMobRequest(input).observeForMs, 0);
  assert.equal(parseHuntMobRequest(input).campSpawner, false);
  assert.throws(() => parseHuntMobRequest({ ...input, camp_spawner: true }), /positive observe_for_ms/);
  assert.equal(parseHuntMobRequest({ ...input, camp_spawner: true, observe_for_ms: 100 }).campSpawner, true);
});

test("an empty camp returns observation_exhausted after one return and a finite wait", async () => {
  const f = fixture();
  const keepAlive = setInterval(() => f.bot.emit("physicsTick"), 2);
  try {
    const result = await f.camp.waitForQuarry(() => false, new AbortController().signal);
    assert.equal(result?.termination, "observation_exhausted");
    assert.equal(f.routes(), 1);
    assert.ok(f.camp.snapshot.observationUntil);
  } finally {
    clearInterval(keepAlive);
  }
});

test("new quarry resumes hunting without resetting an interrupted camp deadline", async () => {
  const f = fixture(30);
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const stop = new AbortController();
  const pending = f.camp.waitForQuarry(() => false, stop.signal);
  const deadline = f.camp.snapshot.observationUntil;
  stop.abort(new Error("reflex takeover"));
  await assert.rejects(pending, /reflex takeover/);
  const again = new AbortController();
  const resumed = f.camp.waitForQuarry(() => false, again.signal);
  assert.equal(f.camp.snapshot.observationUntil, deadline);
  again.abort(new Error("second takeover"));
  await assert.rejects(resumed, /second takeover/);
  assert.equal(await f.camp.waitForQuarry(() => true, new AbortController().signal), null);
  assert.equal(f.camp.snapshot.phase, "hunting");
  assert.equal(f.camp.snapshot.observationUntil, null);
  assert.equal(f.routes(), 0);
});

test("a destroyed camp wakes its wait and reports source loss", async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
  f.destroy();
  assert.equal((await pending)?.termination, "spawner_unavailable");
});

test("failed navigation returns its observation instead of waiting again", async () => {
  const f = fixture();
  const camp = new SpawnerCamp(f.bot, new Vec3(0, 64, 0), 1, async () => ({
    status: "stopped",
    elapsedMs: 1,
    reason: "No safe route",
  }));
  const keepAlive = setInterval(() => f.bot.emit("physicsTick"), 2);
  try {
    const result = await camp.waitForQuarry(() => false, new AbortController().signal);
    assert.equal(result?.termination, "spawner_unreachable");
    assert.match(result?.reason ?? "", /No safe route/);
  } finally {
    clearInterval(keepAlive);
  }
});

test("missing spawner refuses camping without a route or wait", async () => {
  const f = fixture();
  const camp = new SpawnerCamp(f.bot, null, 10, async () => {
    throw new Error("Unexpected route");
  });
  assert.equal(
    (await camp.waitForQuarry(() => false, new AbortController().signal))?.termination,
    "spawner_unavailable",
  );
});
