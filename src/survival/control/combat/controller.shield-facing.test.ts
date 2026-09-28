/** Which way the shield faces incoming projectiles, and the stationary retreat guard. */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import { incomingShieldProjectiles } from "../../perception/combat/shield-projectiles.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { guardRetreatProjectiles } from "../../weapons/projectile-guard.js";
import { projectileShieldFacing, shieldFacing } from "../../weapons/shield-facing.js";
import {
  combatFixture,
  navigationFixture,
  stack,
  stopCombatFixtureClocks,
  type Entity,
} from "./controller.test-support.js";

afterEach(stopCombatFixtureClocks);

test("the shield faces the nearer incoming fireball instead of the first spawned one", () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(0, 64, 0);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  const far = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    position: new Vec3(20, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  const near = Object.assign({}, far, {
    id: 9,
    position: new Vec3(-4, 65, 0),
    velocity: new Vec3(0.5, 0, 0),
  });
  fixture.bot.entities[8] = far;
  fixture.bot.entities[9] = near;
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x < 0);
  near.velocity.set(0.04, 0, 0);
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x > 0, "the farther but faster shot arrives first");
  near.velocity.set(-0.5, 0, 0);
  assert.ok(shieldFacing(fixture.bot, fixture.target, new Set()).x > 0, "ignore an outgoing shot");
});

test("a newly spawned closer fireball does not turn the shield away from the faster arriving shot", () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(-38.51882905638842, 84, 349.4525623707544);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  // EyesBot's last crossfire before the native hit at 1788827792555.
  // Packet positions lag: the older shot was already travelling much faster.
  const fast = Object.assign({}, fixture.target, {
    id: 267,
    name: "small_fireball",
    position: new Vec3(-39.24482423067093, 84.46190628434644, 364.6435395723108),
    velocity: new Vec3(0.0085, 0.044125, -0.821),
  });
  const fresh = Object.assign({}, fast, {
    id: 269,
    position: new Vec3(-29.8190077044475, 87.43404808815258, 346.838228020483),
    velocity: new Vec3(-0.09325, -0.021, 0.029),
  });
  fixture.bot.entities[267] = fast;
  fixture.bot.entities[269] = fresh;
  assert.equal(incomingShieldProjectiles(fixture.bot)[0], fast);
  const heading = shieldFacing(fixture.bot, fixture.target, new Set()).minus(fixture.bot.entity.position);
  heading.y = 0;
  heading.normalize();
  for (const shot of [fast, fresh]) {
    const toward = shot.position.minus(fixture.bot.entity.position);
    toward.y = 0;
    assert.ok(
      heading.dot(toward.normalize()) >= Math.cos((70 * Math.PI) / 180),
      "both observed bearings fit one guard",
    );
  }
});

test("a retreat warning includes a crossing shot before it intersects the stationary body", () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(0, 64, 0);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  const shot = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    position: new Vec3(-2.313, 65.6144, 8.0195),
    velocity: new Vec3(0.5174, -0.0818, -1.1401),
  });
  fixture.bot.entities[8] = shot;
  assert.equal(incomingShieldProjectiles(fixture.bot)[0], undefined, "the observed ray currently misses the body");
  assert.equal(incomingShieldProjectiles(fixture.bot, 2)[0], shot, "movement needs time to stop and ready the shield");
  shot.velocity = shot.velocity.scaled(-1);
  assert.equal(incomingShieldProjectiles(fixture.bot, 2)[0], undefined, "outgoing shots do not retain the guard");
});

test("a movement warning never turns the shield away from a real incoming hit", () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(0, 64, 0);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  const hit = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    position: new Vec3(0, 65, 8),
    velocity: new Vec3(0, 0, -0.2),
  });
  const miss = Object.assign({}, hit, {
    id: 9,
    position: new Vec3(-1.3, 65, -2.5),
    velocity: new Vec3(0.5, 0, 0),
  });
  fixture.bot.entities[8] = hit;
  fixture.bot.entities[9] = miss;
  const aim = projectileShieldFacing(fixture.bot, 2)!;
  const heading = aim.minus(fixture.bot.entity.position);
  heading.y = 0;
  assert.ok(heading.normalize().z >= Math.cos((70 * Math.PI) / 180));
});

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
