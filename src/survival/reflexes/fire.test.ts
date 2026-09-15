import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
import { ReflexDriver } from "../control/driver.js";
import { decideFireResponse } from "../policy/environment.js";
import { attachFireReflex } from "./fire.js";

test("fire response selection replays from the observed escape availability", () => {
  const recorded = JSON.parse(
    JSON.stringify({
      reason: "contact",
      advancing: false,
      inLava: false,
      inFire: false,
      burning: true,
      escapeAvailable: false,
    }),
  );
  assert.equal(decideFireResponse(recorded).kind, "stand_down");
  assert.equal(decideFireResponse({ ...recorded, escapeAvailable: true }).kind, "respond");
  assert.equal(decideFireResponse({ ...recorded, inLava: true }).kind, "respond");
  assert.equal(
    decideFireResponse({ ...recorded, inFire: true }).kind,
    "respond",
    "active fire cannot be mistaken for residual burning",
  );
});

test("burning with no reachable water does not lock a Nether fight out of the body", async () => {
  const bot = Object.assign(new EventEmitter(), {
    health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), metadata: [1], isInLava: false },
    registry: { entitiesByName: { player: { metadataKeys: ["shared_flags"] } } },
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
  }) as unknown as Bot;
  const runner = new ActionRunner();
  let release!: () => void;
  let cancelled = false;
  const claim = runner.claim("hostile_reflex", "fight", async (signal) => {
    signal.addEventListener("abort", () => {
      cancelled = true;
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { value: undefined, continuation: { kind: "return" as const, reason: null } };
  });
  if (claim.kind !== "claimed") throw new Error("Expected claim");
  await Promise.resolve();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
  assert.equal(cancelled, false);
  assert.equal(runner.status().activeAction?.action, "hostile_reflex");
  release();
  await claim.outcome;
});

test("a failed airborne fire escape does not suppress a fresh attempt after landing", async () => {
  const bot = botFixture(
    {},
    {
      stopDigging() {},
      deactivateItem() {},
      clearControlStates() {},
    },
  );
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const observe = async () => {
    for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await observe();
  const first = driver.answered.snapshot()[0];
  assert.equal(first?.failure.kind, "no_escape");
  await observe();
  assert.equal(driver.answered.snapshot()[0]?.id, first.id, "unchanged failure facts prevent repeated claims");
  bot.entity.onGround = true;
  await observe();
  assert.notEqual(driver.answered.snapshot()[0]?.id, first.id, "landing changes the escape's physical premises");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "no_escape");
});
