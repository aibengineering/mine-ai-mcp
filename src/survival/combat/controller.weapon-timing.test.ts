/** Weapon choice and timing: bow draws and releases, shield raises, and melee cooldowns. */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import { createTestCombatController as createCombatController } from "../../test-support/combat.js";
import {
  armWithBow,
  combatFixture,
  navigationFixture,
  stopCombatFixtureClocks,
  type Entity,
} from "./controller.test-support.js";

afterEach(stopCombatFixtureClocks);

test("a blaze fireball still in flight keeps the bow shielded after the charge flag cleared", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], { targetDistance: 26 });
  fixture.target.name = "blaze";
  fixture.target.metadata = [];
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  const shot = Object.assign({}, fixture.target, {
    id: 8,
    name: "small_fireball",
    width: 0.3125,
    position: new Vec3(20, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  fixture.bot.entities[8] = shot;
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 30) shot.isValid = false;
  };
  fixture.script.onShot = () => {
    assert.ok(fixture.clock.tick >= 50, "wait for the projectile to clear, then draw the bow");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(outcome.kind, "died");
  assert.ok(outcome.projectileGuards > 0);
});

test("a shielded melee defender strikes a close blaze whose charging flag remains set", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 2.3 });
  fixture.target.name = "blaze";
  const flags = fixture.bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
  fixture.target.metadata = [];
  Reflect.set(fixture.target.metadata, flags, 1);
  fixture.script.onAttack = () => {
    assert.equal(fixture.bot.usingHeldItem, true, "keep the shield up during the melee swing");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
});

test("a crouching bow draw traces from the observed eye height", async () => {
  const fixture = combatFixture(["bow", "arrow"], { targetDistance: 10 });
  Reflect.set(fixture.bot.entity, "eyeHeight", 1.27);
  const origins: number[] = [];
  fixture.bot.world.raycast = ((from: Vec3) => {
    origins.push(from.y);
    return null;
  }) as Bot["world"]["raycast"];
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  await createCombatController(fixture.bot, navigationFixture()).engage(7, new AbortController().signal, "hold");
  assert.ok(origins.length > 0);
  assert.ok(Math.abs(origins[0]! - 65.17) < 1e-6, "arrow origin is 0.1 below the crouched eye");
});

test("ends bow combat when a windup outlasts its guard limit", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], {
    targetDistance: 10,
  });
  armWithBow(fixture.target).drawing(true);
  Object.assign(fixture.target, { kind: "Hostile mobs", headYaw: Math.PI / 2, pitch: 0 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  const cancellation = new AbortController();
  fixture.script.onWait = () => {
    // A broken guard must not hang the test: this is beyond two existing guard windows.
    if (fixture.clock.tick >= 250) cancellation.abort("guard did not settle");
  };

  const outcome = await createCombatController(fixture.bot, {
    ...navigationFixture(),
    navigate: async () => ({ status: "stopped", reason: "No alternate cover exists in this fixture.", elapsedMs: 0 }),
  }).engage(7, cancellation.signal, "pursue");

  assert.equal(outcome.kind, "unreachable", JSON.stringify(outcome));
  assert.equal(outcome.attacks, 0);
  assert.equal(outcome.projectileGuards, 2, "initial facing guard, then the bounded bow window guard");
  assert.equal(fixture.controlsCleared.count, 1);
  assert.equal(cancellation.signal.aborted, false);
});

test("prefers a usable bow at range and keeps a carried shield in the off hand", async () => {
  const fixture = combatFixture(["iron_sword", "shield", "bow", "arrow"], { targetDistance: 10 });

  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "died",
    targetId: 7,
    attacks: 1,
    stylesUsed: ["bow"],
    weaponsUsed: ["bow"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.deepEqual(fixture.equipped, ["shield:off-hand", "bow:hand"]);
  assert.equal(fixture.directAttacks.count, 0);
  assert.deepEqual(fixture.controls, []);
  assert.deepEqual(fixture.shotTicks, [20], "release one fully drawn arrow");
});

test("raises the shield when a bow target starts drawing, then resumes its own shot", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], { targetDistance: 10 });
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  Object.assign(fixture.target, { kind: "Hostile mobs", headYaw: Math.PI / 2, pitch: 0 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  fixture.script.onWait = () => {
    if (fixture.clock.tick >= 3) skeleton.drawing(false);
  };
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.projectileGuards, 1);
  assert.equal(outcome.attacks, 1);
  assert.deepEqual(fixture.equipped, ["shield:off-hand", "bow:hand"]);
  assert.equal(fixture.shotTicks.length, 1, "the interrupted draw did not fire a second arrow");
  assert.ok(fixture.timeline.indexOf("shield-up") < fixture.timeline.indexOf("item-use"),
    "an existing threat is guarded before beginning a draw");
  assert.equal(fixture.timeline.filter((event) => event === "item-use").length, 1);
  assert.equal(
    fixture.timeline.indexOf("item-down", fixture.timeline.indexOf("item-use")) > fixture.timeline.indexOf("shield-up"),
    true,
    "no arrow left the bow before the shield",
  );
});

test("keeps the shield raised while attacking and waits the cooldown in place", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 6) fixture.bot.emit("entitySwingArm", fixture.target);
  };

  fixture.script.onAttack = () => {
    if (fixture.directAttacks.count === 2) fixture.bot.emit("entityDead", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "died",
    targetId: 7,
    attacks: 2,
    stylesUsed: ["shielded_melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 1,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.deepEqual(fixture.equipped, ["shield:off-hand", "iron_sword:hand"]);
  assert.deepEqual(fixture.controls, []);
  assert.equal(fixture.itemUse[0], true);
  assert.deepEqual(fixture.attackTicks, [13, 26], "weapon readiness includes shield raise, then sword cooldown");
  const attack = fixture.timeline.indexOf("attack");
  const secondAttack = fixture.timeline.indexOf("attack", attack + 1);
  assert.equal(fixture.timeline[attack + 1], "shield-up");
  assert.equal(fixture.timeline.slice(0, secondAttack).includes("item-down"), false);
});

test("shielded melee strikes a drawing skeleton before it backs out of reach", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  fixture.script.onWait = () => {
    if (fixture.clock.tick >= 20) fixture.bot.emit("entityGone", fixture.target);
  };

  fixture.script.onAttack = () => {
    assert.equal(fixture.bot.usingHeldItem, true, "the shield remains raised through the swing");
    fixture.bot.emit("entityDead", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.projectileGuards, 1);
  assert.equal(outcome.attacks, 1);
  assert.ok(fixture.clock.tick < 20, "waiting for the volley lets the skeleton leave before the swing");
});

test("rechecks for a bow draw after the melee shield readiness wait", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 2) skeleton.drawing(true);
    if (fixture.clock.tick === 8) skeleton.drawing(false);
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.projectileGuards, 1);
  assert.equal(outcome.attacks, 1);
  assert.ok(fixture.clock.tick > 5, "the swing waited through the draw that began during shield readiness");
});

test("resumes a shielded approach when a drawing target backs out of melee reach", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 6) fixture.target.position.x = 4;
    if (fixture.clock.tick >= 20) skeleton.drawing(false);
  };
  const navigation = {
    ...navigationFixture(),
    navigate: async () => {
      assert.ok(fixture.clock.tick < 20, "follow the retreat while the shield covers the draw");
      assert.equal(fixture.timeline.includes("item-down"), false, "keep the shield raised for the walk");
      fixture.target.position.x = 2;
      skeleton.drawing(false);
      return { status: "completed", elapsedMs: 0 } as const;
    },
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
});

test("does not reset an already-raised melee shield for the next bow volley", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  let ticksAfterFirstAttack = 0;
  fixture.script.onWait = () => {
    if (fixture.directAttacks.count !== 1) return;
    ticksAfterFirstAttack += 1;
    if (ticksAfterFirstAttack === 1) skeleton.drawing(true);
    if (ticksAfterFirstAttack === 16) skeleton.drawing(false);
  };
  fixture.script.onAttack = () => {
    if (fixture.directAttacks.count === 2) fixture.bot.emit("entityDead", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.projectileGuards, 1);
  assert.equal(outcome.attacks, 2);
  const firstAttack = fixture.timeline.indexOf("attack");
  const secondAttack = fixture.timeline.indexOf("attack", firstAttack + 1);
  assert.equal(fixture.timeline.slice(firstAttack + 1, secondAttack).includes("item-down"), false);
});

test("plain melee waits the sword cooldown facing the target, without walking backwards", async () => {
  const fixture = combatFixture(["iron_sword"]);
  fixture.script.onAttack = () => {
    if (fixture.directAttacks.count === 2) fixture.bot.emit("entityDead", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "died",
    targetId: 7,
    attacks: 2,
    stylesUsed: ["melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.deepEqual(fixture.equipped, ["iron_sword:hand"]);
  assert.deepEqual(fixture.controls, []);
  assert.deepEqual(fixture.attackTicks, [13, 26], "the second sword swing waits thirteen elapsed ticks");
});

test("deliberately empties its hand and punches when it has no recognized melee item", async () => {
  const fixture = combatFixture([], { startingHeld: "dirt" });

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "died",
    targetId: 7,
    attacks: 1,
    stylesUsed: ["melee"],
    weaponsUsed: ["hand"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.deepEqual(fixture.equipped, []);
  assert.deepEqual(fixture.unequipped, ["hand"]);
});

test("uses an available shield while punching", async () => {
  const fixture = combatFixture(["shield"]);
  let emittedSwing = false;
  fixture.script.onWait = () => {
    if (!emittedSwing) {
      emittedSwing = true;
      fixture.bot.emit("entitySwingArm", fixture.target);
    }
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "died",
    targetId: 7,
    attacks: 1,
    stylesUsed: ["shielded_melee"],
    weaponsUsed: ["hand"],
    shieldRaisedSwings: 1,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.deepEqual(fixture.equipped, ["shield:off-hand"]);
});

for (const tick of [1, 20]) {
  for (const event of ["cancel", "target death"] as const) {
    test(`${event} on draw tick ${tick} cancels the bow without firing`, async () => {
      const fixture = combatFixture(["bow", "arrow"], { targetDistance: 10 });
      const cancellation = new AbortController();
      fixture.script.onWait = () => {
        if (fixture.clock.tick !== tick) return;
        if (event === "cancel") cancellation.abort("draw interrupted");
        else fixture.bot.emit("entityDead", fixture.target);
      };

      const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
        7,
        cancellation.signal,
        "pursue",
      );

      assert.equal(outcome.kind, event === "cancel" ? "cancelled" : "died");
      assert.equal(outcome.attacks, 0);
      assert.deepEqual(fixture.shotTicks, [], "cancelling use must not release an arrow");
      assert.equal(fixture.bot.usingHeldItem, false);
      assert.equal(fixture.bot.quickBarSlot, 0);
      assert.equal(fixture.controlsCleared.count, 1);
    });
  }
}

test("releasing an arrow is not evidence that the target died", async () => {
  const fixture = combatFixture(["bow", "arrow"], { targetDistance: 10 });
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 21) fixture.bot.emit("entityGone", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  assert.equal(outcome.attacks, 1);
  assert.deepEqual(fixture.shotTicks, [20]);
  assert.equal(fixture.bot.usingHeldItem, false);
});

for (const interruptTick of [10, 20]) test(`a newly visible drawing skeleton at bow tick ${interruptTick} cancels the shot and guards`, async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], { targetDistance: 12 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  const second = { id: 9, name: "skeleton", kind: "Hostile mobs", isValid: true,
    position: new Vec3(0, 64, 8), width: 0.6, height: 1.99, headYaw: 0, pitch: 0 } as unknown as Entity;
  const skeleton = armWithBow(second);
  let drawingTicks = 0;
  fixture.script.onWait = () => {
    if (!fixture.timeline.includes("item-use")) return;
    drawingTicks++;
    if (drawingTicks === interruptTick) fixture.bot.entities[second.id] = second;
    skeleton.drawing(drawingTicks >= interruptTick && drawingTicks < interruptTick + 8);
  };
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7, new AbortController().signal, "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
  assert.equal(fixture.shotTicks.length, 1, "cancelling the first draw must not release an arrow");
  assert.ok(fixture.timeline.indexOf("slot:1") < fixture.timeline.indexOf("shield-up"), JSON.stringify(fixture.timeline));
  assert.equal(fixture.timeline.filter(event => event === "item-use").length, 2);
  assert.ok(fixture.shotTicks[0]! >= interruptTick + 8 + 20, "shoot only after the threat clears and a fresh draw completes");
});

test("a known late skeleton draw leaves time to release and restore protection", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], { targetDistance: 12 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  const second = { id: 9, name: "skeleton", kind: "Hostile mobs", isValid: true,
    position: new Vec3(0, 64, 8), width: 0.6, height: 1.99, headYaw: 0, pitch: 0 } as unknown as Entity;
  const skeleton = armWithBow(second);
  fixture.bot.entities[9] = second;
  let drawingTicks = 0;
  fixture.script.onWait = () => {
    if (fixture.timeline.includes("item-use") && ++drawingTicks === 10) skeleton.drawing(true);
  };
  fixture.script.onShot = () => {
    assert.equal(drawingTicks, 20);
    skeleton.drawing(false);
    fixture.bot.emit("entityDead", fixture.target);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7, new AbortController().signal, "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(fixture.shotTicks.length, 1);
  assert.equal(fixture.timeline.includes("slot:1"), false, "the safe shot is not cancelled");
});
