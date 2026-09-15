import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../test-support/bot.js";
import { flatWorld } from "../../test-support/navigation.js";
import { SupportedPositionHold } from "./supported-position.js";

/**
 * A body standing on the flat world's floor, with every control the hold writes
 * recorded rather than sent. `overrides` carries whatever else the case needs:
 * the protocol client, or a `waitForTicks` that decides what the body does
 * while the hold waits for its landing.
 */
function holdFixture(feetX: number, yaw: number, overrides: Record<string, unknown> = {}, edge = false) {
  const controls = new Map<string, boolean>();
  const bot = botFixture(
    { position: { x: feetX, y: 63, z: 0.5 } },
    { setControlState: (key: string, value: boolean) => controls.set(key, value), ...overrides },
  );
  bot.entity.yaw = yaw;
  const world = flatWorld();
  if (edge) for (let z = -5; z <= 5; z++) world.load({ x: 1, y: 62, z }, { stateId: 0 });
  return { bot, body: bot.entity, controls, hold: new SupportedPositionHold(bot, world) };
}

/** Whether the hold currently asks for no movement at all. */
function released(controls: Map<string, boolean>): boolean {
  return [...controls.values()].every((value) => !value);
}

test("combat holds the supporting cell through a knockback hop without changing shield facing", () => {
  const { body, controls, hold } = holdFixture(0.5, Math.PI / 2);
  hold.tick();
  assert.equal(controls.get("forward"), false, "a centred resting body needs no correction");
  assert.equal(controls.get("sneak"), false, "holding a centred body must not force a crouching posture");

  body.onGround = false;
  body.position.set(0.8, 63.9, 0.5);
  hold.tick();
  assert.equal(body.yaw, Math.PI / 2);
  assert.equal(controls.get("forward"), true, "face west and move back toward the support");
  assert.equal(controls.get("sneak"), false, "air control must not be slowed by sneaking");

  hold.release();
  assert.ok(released(controls), "navigation receives released movement controls");
  body.position.set(0.9, 63.8, 0.5);
  hold.tick();
  assert.ok(released(controls), "a new owner cannot inherit the previous stance");
});

test("losing observed support releases an earlier combat correction", () => {
  const { body, controls, hold } = holdFixture(0.8, 0, {}, true);
  hold.tick();
  assert.equal(controls.get("left"), true);
  body.position.set(0.8, 61, 0.5);
  hold.tick();
  assert.ok(released(controls), "do not keep steering toward a floor above the bot");
});

test("finishing combat retains correction until an airborne body lands safely", async () => {
  let waits = 0;
  const { bot, body, controls, hold } = holdFixture(0.5, Math.PI / 2);
  bot.waitForTicks = async () => {
    waits++;
    assert.equal(controls.get("forward"), true, "steer toward the remembered support before waiting");
    body.position.set(0.5, 63, 0.5);
    body.onGround = true;
  };
  hold.tick();
  body.position.set(0.9, 63.8, 0.5);
  body.onGround = false;

  await hold.stop();
  assert.equal(waits, 1);
  assert.equal(body.onGround, true);
  hold.release();
  assert.ok(released(controls));
});

test("an unavailable landing does not keep combat cleanup waiting", async () => {
  for (const end of ["water", "dead"] as const) {
    let waits = 0;
    const { bot, body, hold } = holdFixture(0.5, 0);
    bot.waitForTicks = async () => {
      waits++;
      throw new Error("No recoverable landing remains");
    };
    hold.tick();
    body.onGround = false;
    if (end === "water") Reflect.set(body, "isInWater", true);
    if (end === "dead") bot.health = 0;

    await hold.stop();
    assert.equal(waits, 0, `${end}: cleanup must not wait for a landing that cannot come`);
    assert.equal(hold.active, false, end);
    hold.release();
  }
});

test("a route that stops airborne hands back its latest observed support", async () => {
  const { bot, body, controls, hold } = holdFixture(0.5, Math.PI / 2);
  bot.waitForTicks = async () => {
    assert.equal(controls.get("forward"), true);
    body.position.set(3.5, 63, 0.5);
    body.onGround = true;
  };
  await hold.stop();
  body.position.x = 3.5;
  hold.tick();
  assert.equal(controls.size, 0, "observing a route does not take its controls");

  body.position.set(3.9, 63.8, 0.5);
  body.onGround = false;
  hold.start();
  await hold.stop();
  assert.equal(body.position.x, 3.5);
  assert.equal(hold.active, false);
});

test("a correction's crouch reaches the 1.21.4 server, and its release always does", () => {
  const protocol: string[] = [];
  const { body, controls, hold } = holdFixture(0.8, 0, {
    version: "1.21.4",
    _client: { write: (name: string, fields: { actionId: number }) => protocol.push(`${name}:${fields.actionId}`) },
  }, true);
  hold.tick();
  assert.equal(controls.get("sneak"), true, "an off-centre body corrects inward crouched");
  hold.tick();
  assert.deepEqual(protocol, ["entity_action:0"], "one press for the whole correction, not one per tick");

  body.position.set(0.5, 63, 0.5);
  hold.tick();
  assert.equal(controls.get("sneak"), false, "a centred body stands");
  assert.deepEqual(protocol, ["entity_action:0", "entity_action:1"], "the server hears the release");

  hold.release();
  assert.deepEqual(
    protocol,
    ["entity_action:0", "entity_action:1", "entity_action:1"],
    "release repeats the stop whatever the hold last wrote, so a latched server stands too",
  );
});

test("off-centre guard on continuous safe flooring neither recentres nor crouches", () => {
  const { body, controls, hold } = holdFixture(0.8, 0);
  body.velocity.x = 0.1;
  hold.tick();
  assert.ok(released(controls));
});
