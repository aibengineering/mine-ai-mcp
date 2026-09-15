import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { incomingFireball } from "../perception/combat/fireball.js";
import { deflectFireball } from "./deflect.js";

function fixture() {
  const ball = {
    id: 2,
    name: "fireball",
    isValid: true,
    position: new Vec3(4.17, 1.5, 0),
    velocity: new Vec3(-1.06, 0, 0),
    width: 1,
    height: 1,
  };
  let swings = 0;
  const bot = {
    entity: { position: new Vec3(0.5, 0, 0), height: 1.8 },
    entities: { 2: ball },
    health: 20,
    clearControlStates() {},
    deactivateItem() {},
    lookAt: async () => {},
    attack: () => {
      swings += 1;
    },
    waitForTicks: async () => {
      ball.velocity.x = 1;
    },
  };
  return { bot, ball, swings: () => swings, port: bot as unknown as Bot };
}

test("large incoming shots are threats; outbound shots, misses and blaze shots are not", () => {
  const { port, ball } = fixture();
  assert.equal(incomingFireball(port, 16)?.id, 2);
  ball.velocity.x = 1;
  assert.equal(incomingFireball(port, 16), undefined);
  ball.velocity.x = -1;
  ball.position.z = 5;
  assert.equal(incomingFireball(port, 16), undefined);
  ball.position.z = 0;
  ball.name = "small_fireball";
  assert.equal(incomingFireball(port, 16), undefined);
});

test("a server update outside reach can require a swing before the next position packet", async () => {
  const { port, swings } = fixture();
  const result = await deflectFireball(port, 2, new AbortController().signal);
  assert.equal(swings(), 1);
  assert.equal(result.kind, "reflected");
});

test("a swing followed by disappearance is not evidence of reflection", async () => {
  const { port, bot, ball, swings } = fixture();
  bot.waitForTicks = async () => {
    ball.isValid = false;
  };
  const result = await deflectFireball(port, 2, new AbortController().signal);
  assert.equal(swings(), 1);
  assert.equal(result.kind, "unobserved");
});

test("cancellation while aiming prevents a late swing", async () => {
  const { port, bot, swings } = fixture();
  const stop = new AbortController();
  bot.lookAt = async () => {
    stop.abort(new Error("cancelled"));
  };
  await assert.rejects(deflectFireball(port, 2, stop.signal), /cancelled/);
  assert.equal(swings(), 0);
});
