import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { DragonShotObservation } from "./dragon-shot.js";

function fixture() {
  const dragon = { id: 42, name: "ender_dragon", isValid: true, position: new Vec3(30, 84, 0),
    velocity: new Vec3(0, 0, 0), yaw: 0, metadata: { 9: 190, 16: 1 } } as unknown as Bot["entity"];
  const bot = botFixture({ dimension: "the_end", groundY: 63, entities: { 42: dragon } });
  return { bot, dragon };
}

test("disappearance and numeric entity-id reuse do not manufacture a bow hit", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.bot.entities[42] = { ...f.dragon, metadata: { 9: 0, 16: 9 } } as unknown as Bot["entity"];
  f.bot.emit("entityUpdate", f.bot.entities[42]);
  assert.equal(observation.loaded, false);
  assert.equal(observation.damageObserved, 0);
  assert.equal(observation.died, false);
  using deadDragon = new DragonShotObservation(f.bot, 42);
  assert.equal(deadDragon.died, true, "already observed zero health survives the gap between requests");
  f.bot.entities[42]!.name = "cow";
  using wrongSpecies = new DragonShotObservation(f.bot, 42);
  assert.equal(wrongSpecies.died, false);
});

test("native death remains terminal when its health metadata packet is still stale", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.bot.emit("entityDead", f.dragon);
  f.bot.emit("physicsTick");
  assert.equal(observation.died, true);
  assert.equal(observation.healthAfter, 0);
});
