/** The stationary retreat guard under a live controller fixture. Which way a
 * shield faces a given set of projectiles is tested in shield-projectiles.test.ts. */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { guardRetreatProjectiles } from "../../weapons/projectile-guard.js";
import {
  combatFixture,
  navigationFixture,
  stack,
  stopCombatFixtureClocks,
  type Entity,
} from "./controller.test-support.js";

afterEach(stopCombatFixtureClocks);

test("a settled retreat guards an incoming blaze projectile and releases the shield before moving again", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(0.5, 64, 0.5);
  fixture.bot.health = 20;
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  await fixture.bot.equip(stack(fixture.bot, "shield"), "off-hand");
  const projectile = {
    ...fixture.target,
    id: 8,
    name: "small_fireball",
    width: 0.3125,
    position: new Vec3(4, 64.9, 0.5),
    velocity: new Vec3(-0.5, 0, 0),
  } as Entity;
  fixture.bot.entities[8] = projectile;
  fixture.script.onWait = () => {
    if (fixture.clock.tick < 8) assert.equal(fixture.bot.usingHeldItem, true);
    if (fixture.clock.tick === 8) projectile.isValid = false;
  };
  await guardRetreatProjectiles(
    fixture.bot,
    navigationFixture(),
    new AbortController().signal,
    Date.now() + 15_000,
    DEFAULT_COMBAT_POLICY,
  );
  assert.ok(fixture.clock.tick >= 8, "wait for the observed projectile to clear");
  assert.equal(fixture.bot.usingHeldItem, false, "do not carry shield slowdown into the next escape route");
});

for (const loss of ["health", "shield", "blast clearance"] as const) {
  test(`a stationary retreat guard yields when it loses ${loss}`, async () => {
    const fixture = combatFixture(["iron_sword", "shield"]);
    fixture.bot.entity.position.set(0.5, 64, 0.5);
    fixture.bot.health = 11;
    fixture.bot.entity.width = 0.6;
    fixture.bot.entity.height = 1.8;
    fixture.bot.entity.onGround = true;
    fixture.bot.entity.velocity = new Vec3(0, 0, 0);
    await fixture.bot.equip(stack(fixture.bot, "shield"), "off-hand");
    const projectile = Object.assign({}, fixture.target, {
      id: 8,
      name: "small_fireball",
      position: new Vec3(4, 64.9, 0.5),
      velocity: new Vec3(-0.5, 0, 0),
    });
    fixture.bot.entities[8] = projectile;
    fixture.script.onWait = () => {
      if (fixture.clock.tick === 8) {
        if (loss === "health") fixture.bot.health = 7;
        else if (loss === "shield") fixture.bot.inventory.slots[45] = null;
      }
      if (fixture.clock.tick === 100) projectile.isValid = false;
    };
    const result = await guardRetreatProjectiles(
      fixture.bot,
      navigationFixture(),
      new AbortController().signal,
      Date.now() + 15_000,
      DEFAULT_COMBAT_POLICY,
      () => loss === "blast clearance" && fixture.clock.tick >= 3,
    );
    assert.ok(fixture.clock.tick < 12, "return control to the reflex policy instead of waiting through further hits");
    assert.equal(result?.kind, loss === "blast clearance" ? "finished" : "stopped");
    if (loss === "blast clearance") assert.ok(fixture.clock.tick <= 4, "blast danger interrupts even the initial shield readiness wait");
    assert.equal(fixture.bot.usingHeldItem, false);
  });
}
