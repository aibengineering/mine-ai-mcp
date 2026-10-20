import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { MemoryWorld as GoalTestWorld } from "../../../navigation/world/memory-world.js";
import { botFixture } from "../../../test-support/bot.js";
import {
  createTestCombatController as createCombatController,
  disposeCombatTestResources,
} from "../../../test-support/combat.js";
import { observation } from "../../../test-support/navigation.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { PerchObservation } from "../../perception/combat/perch.js";
import { FightMovement } from "../../responses/fight/movement.js";
import {
  armWithBow,
  blazePreflightFixture,
  combatFixture,
  editPolicy,
  navigationFixture,
  stack,
  stopCombatFixtureClocks,
  type Entity,
} from "./controller.test-support.js";

const goalTestWorld = new GoalTestWorld();
afterEach(stopCombatFixtureClocks);

test("revoking raw food releases an End perch bite before policy settlement", async () => {
  let began!: () => void;
  const biting = new Promise<void>((resolve) => { began = resolve; });
  let rejectBite!: (cause: Error) => void;
  const bot = botFixture({ items: [{ name: "beef", count: 2 }] }, {
    _client: new EventEmitter(),
    clearControlStates: () => {},
    food: 6, health: 20,
    consume: () => new Promise<void>((_resolve, reject) => {
      rejectBite = reject;
      bot.usingHeldItem = true;
      began();
    }),
    deactivateItem: () => { bot.usingHeldItem = false; rejectBite?.(new Error("native bite released")); },
  });
  bot.entities[42] = {
    id: 42, name: "ender_dragon", isValid: true,
    position: new Vec3(0, 95, 0), velocity: new Vec3(0, 0, 0), yaw: 0,
    metadata: { 9: 200, 16: 0 },
  } as unknown as Bot["entity"];
  using observation = new PerchObservation(bot, 42);
  const controller = createCombatController(bot, navigationFixture());
  const perch = controller.runEnd({ kind: "perch", targetId: 42, observation }, new AbortController().signal);
  const cancelled = assert.rejects(perch, /Combat policy changed/);
  await biting;
  await editPolicy(controller, { food: { raw: { allow: "never" } } }, "cook the meat");
  await cancelled;
  assert.equal(bot.usingHeldItem, false);
  assert.equal(controller.activeEngagement(), null);
  assert.equal(controller.policy.settling, false);
  assert.equal(bot.inventory.items()[0]?.count, 2);
});

test("shield-only defence observes target death before requesting another guard", async () => {
  const fixture = combatFixture(["shield"]);
  const controller = createCombatController(fixture.bot, navigationFixture());
  await editPolicy(controller, { combat: { melee: false, bow: false } });
  fixture.script.onWait = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await controller.engage(7, new AbortController().signal, "hold");
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 0);
  assert.equal(controller.activeEngagement(), null);
});

test("the shared controller enforces policy health before any deliberate combat effect", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.target.kind = "Hostile mobs";
  fixture.bot.health = 9;
  fixture.bot.equip = async () => assert.fail("No equipment effect before admission");
  const controller = createCombatController(fixture.bot, navigationFixture());
  await editPolicy(controller, { combat: { recover: "never" } });
  const result = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "capability_blocked");
  assert.equal(result.attacks, 0);
});

test("the shared controller releases an unprotected pursuit when health falls", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.target.kind = "Hostile mobs";
  fixture.script.onWait = () => {
    fixture.bot.health = 7;
    fixture.bot.emit("health");
  };
  const controller = createCombatController(fixture.bot, navigationFixture());
  await editPolicy(controller, { combat: { recover: "never" } });
  const result = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "capability_blocked");
  assert.equal(fixture.bot.listenerCount("health"), 0);
});

test("an excavating approach stops when its target reaches an unsafe ledge", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 14 });
  fixture.bot.entity.position.set(6.5, 64, 0.5);
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  let stoppedForContact = false;
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async (options) => {
      // The route was allowed to dig while the target was far away. It walks
      // into reach with void behind us before the planned stance is reached.
      fixture.target.position.set(5.5, 64, 0.5);
      fixture.bot.emit("physicsTick");
      stoppedForContact = options.stopSignal?.aborted === true;
      fixture.bot.emit("entityDead", fixture.target);
      return { status: "stopped", reason: "test contact", elapsedMs: 1 };
    },
  };
  await createCombatController(fixture.bot, navigation).engage(7, new AbortController().signal, "pursue");
  assert.equal(stoppedForContact, true, "stop excavation before choosing an existing defensive stance");
});

test("a carried bow cannot satisfy a route that is finding a safe melee stance", async () => {
  const fixture = blazePreflightFixture(["iron_sword", "bow", "arrow", "cobblestone"]);
  stack(fixture.bot, "cobblestone").count = 64;
  fixture.target.position.set(2.5, 64, 0.5);
  fixture.target.metadata = [];
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  for (let x = -3; x < 0; x++) fixture.world.load({ x, y: 63, z: 0 }, { stateId: 0 });
  let routes = 0;
  const result = await createCombatController(fixture.bot, {
    ...fixture.navigation,
    navigate: async ({ goal }) => {
      routes++;
      const resolved = goal.resolve(observation(0.5, 64, 0.5));
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("Expected a melee stance goal.");
      assert.equal(
        resolved.isSatisfied({ feet: { x: 0, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "0" }, fixture.world),
        false,
      );
      return { status: "stopped", reason: "no supported melee stance", elapsedMs: 1 };
    },
  }).engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "unreachable");
  assert.equal(result.attacks, 0);
  assert.equal(routes, 1);
});

test("a shielded defender retains facing instead of routing away from contact on a ledge", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  using perception = new CombatPerception(fixture.bot);
  fixture.bot.emit("entityHurt", fixture.bot.entity, fixture.target);
  fixture.bot.entity.position.set(6.5, 64, 0.5);
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  fixture.target.position.set(5.5, 64, 0.5);
  let routes = 0;
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async () => {
      routes++;
      return { status: "stopped", reason: "no reachable supported stance", elapsedMs: 1 };
    },
  };
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await createCombatController(fixture.bot, navigation, perception).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
  assert.equal(routes, 0, "contact must not hand shield facing to a safer-stance route");
});

test("holding a ledge defends against a contact attacker without searching away from that position", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.entity.position.set(6.5, 64, 0.5);
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  fixture.target.position.set(5.5, 64, 0.5);
  let routes = 0;
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async () => {
      routes++;
      return { status: "stopped", reason: "no reachable supported stance", elapsedMs: 1 };
    },
  };
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await createCombatController(fixture.bot, navigation).engage(7, new AbortController().signal, "hold");
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
  assert.equal(routes, 0, "holding must not abandon the caller's fighting position");
});

test("holding uses a bow for a target outside sword reach even inside the pursuit bow cutoff", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow", "shield"], { targetDistance: 5 });
  fixture.target.name = "blaze";
  fixture.target.metadata = [];
  const cancelled = new AbortController();
  fixture.script.onWait = () => {
    if (fixture.clock.tick > 100) cancelled.abort("test observed a stationary weapon-selection stall");
  };
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await createCombatController(fixture.bot, navigationFixture()).engage(7, cancelled.signal, "hold");
  assert.equal(result.kind, "died");
  assert.deepEqual(result.stylesUsed, ["bow"]);
});

test("a close ranged attacker with a clear shot is answered by the bow instead of an unreachable melee approach", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow", "shield"], { targetDistance: 5 });
  fixture.target.name = "blaze";
  fixture.target.metadata = [];
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await createCombatController(fixture.bot, {
    ...navigationFixture(),
    navigate: async () => {
      throw new Error("a usable clear shot must not start a melee route");
    },
  }).engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "died");
  assert.deepEqual(result.stylesUsed, ["bow"]);
});

test("an obstructed shooter approach can finish at a bow opening outside melee reach", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow", "shield"], { targetDistance: 5 });
  fixture.target.name = "blaze";
  fixture.target.metadata = [];
  fixture.target.isValid = true;
  const opening = new Vec3(-2, 64, 2);
  fixture.bot.world.raycast = () =>
    fixture.bot.entity.position.x < -1 ? null : { x: 1, y: 65, z: 0, face: 4, intersect: new Vec3(1, 65, 0) };
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  let approaches = 0;
  const navigation = navigationFixture();
  const result = await createCombatController(fixture.bot, {
    ...navigation,
    navigate: async ({ goal }) => {
      approaches++;
      const resolved = goal.resolve(observation());
      assert.equal(resolved.kind, "active");
      if (resolved.kind !== "active") throw new Error("Expected a live attack goal.");
      assert.ok(resolved.isSatisfied({ feet: opening, remainingScaffolds: 0, overlayId: "0" }, navigation.world));
      fixture.bot.entity.position = opening.offset(0.5, 0, 0.5);
      return { status: "completed", elapsedMs: 1 };
    },
  }).engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "died");
  assert.equal(approaches, 1);
  assert.ok(result.stylesUsed.includes("bow"));
});

test("defensive melee raises the shield in warning range and lets the mob close without navigating", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 4 });
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 8) fixture.target.position.x = 2;
  };
  fixture.script.onAttack = () => {
    assert.ok(fixture.clock.tick >= 8);
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(result.kind, "died");
  assert.ok(fixture.timeline.includes("shield-up"));
  assert.deepEqual(fixture.controls, []);
});

test("a hunter waits for a nearby hopping cube to descend instead of climbing toward its airborne feet", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 2 });
  fixture.target.name = "magma_cube";
  fixture.target.height = fixture.target.width = 0.52;
  const metadata: unknown[] = [];
  metadata[fixture.bot.registry.entitiesByName.magma_cube!.metadataKeys!.indexOf("size")] = 4;
  fixture.target.metadata = metadata as Entity["metadata"];
  fixture.target.position.y = 70;
  fixture.bot.blockAt = (() => ({ boundingBox: "empty" })) as unknown as Bot["blockAt"];
  fixture.script.onWait = () => {
    if (fixture.clock.tick >= 20) fixture.target.position.y = 64;
  };
  fixture.script.onAttack = () => {
    assert.ok(fixture.clock.tick >= 20, "only the descended body is in attack reach");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
  assert.deepEqual(fixture.controls, []);
});

test("switching back from a navigation tool restores sword attack strength before swinging", async () => {
  const fixture = combatFixture(["iron_sword", "iron_pickaxe", "shield"], { targetDistance: 8 });
  let changedAt = 0;
  const navigation = {
    ...navigationFixture(),
    navigate: async () => {
      await fixture.bot.waitForTicks(20);
      await fixture.bot.equip(stack(fixture.bot, "iron_pickaxe"), "hand");
      fixture.bot.deactivateItem();
      fixture.target.position.x = 2;
      changedAt = fixture.clock.tick;
      return { status: "completed", elapsedMs: 0 } as const;
    },
  };
  fixture.script.onAttack = () => {
    assert.ok(fixture.clock.tick >= changedAt + 13, "time before the weapon switch cannot pay its cooldown");
    assert.equal(fixture.bot.usingHeldItem, true, "navigation's tool use invalidates the previous guard");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
});

test("a guarded approach that only walked swings without paying shield readiness again", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 8 });
  armWithBow(fixture.target).drawing(true);
  let returnedAt = 0;
  const navigation = {
    ...navigationFixture(),
    navigate: async () => {
      await fixture.bot.waitForTicks(20);
      fixture.target.position.x = 2;
      returnedAt = fixture.clock.tick;
      return { status: "completed", elapsedMs: 0 } as const;
    },
  };
  fixture.script.onAttack = () => {
    // A retreating skeleton steps out of reach in the five ticks a second
    // readiness wait costs; the guard raised before the route is still up.
    assert.ok(
      fixture.clock.tick <= returnedAt + 2,
      `swing at tick ${fixture.clock.tick} after the route returned at ${returnedAt}`,
    );
    assert.equal(fixture.bot.usingHeldItem, true);
    assert.equal(fixture.timeline.filter((entry) => entry === "shield-up").length, 1, "one raise, before the route");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
});

test("a pack member in reach is answered before chasing the requested target, without settling its verdict", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 7 });
  const { bot, target } = fixture;
  const contact = {
    ...target,
    id: 8,
    name: "magma_cube",
    kind: "Hostile mobs",
    isValid: true,
    height: 1.04,
    width: 1.04,
    metadata: [] as Entity["metadata"],
    position: new Vec3(-2, 64, 0),
  } as Entity;
  bot.entities[contact.id] = contact;
  const attacked: number[] = [];
  bot.attack = (entity) => {
    attacked.push(entity.id);
    bot.emit("entityDead", entity);
    // Dying entities remain valid briefly. They must not hold the guard.
    if (entity.id === contact.id) target.position = new Vec3(2, 64, 0);
  };
  const result = await createCombatController(bot, navigationFixture()).engage(
    target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.deepEqual(attacked, [contact.id, target.id]);
  assert.equal(result.kind, "died");
  assert.equal(result.targetId, target.id);
  assert.equal(result.attacks, 2);
});

test("melee cooldown guards a nearer pack member behind the bot without spending another swing", async () => {
  const { bot, target, script, attackTicks, clock } = combatFixture(["iron_sword", "shield"]);
  const contact = {
    ...target,
    id: 8,
    name: "magma_cube",
    kind: "Hostile mobs",
    isValid: true,
    height: 1.04,
    width: 1.04,
    metadata: [] as Entity["metadata"],
    position: new Vec3(-1, 64, 0),
  } as Entity;
  const guarded: number[] = [];
  script.onAttack = () => {
    bot.entities[contact.id] = contact;
  };
  script.onWait = () => {
    if (attackTicks.length === 0) return;
    guarded.push(bot.entity.yaw);
    if (clock.tick === attackTicks[0]! + 3) bot.emit("entityDead", target);
  };
  const result = await createCombatController(bot, navigationFixture()).engage(
    target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(attackTicks.length, 1);
  assert.ok(guarded.every((yaw) => Math.abs(yaw - Math.PI / 2) < 0.001));
});

test("a kill hands the guard over raised while the partner is closing", async () => {
  // The 2026-10-20 crossing: the first wither skeleton died with its partner
  // 3.3 blocks off. The release lowered the shield and the next fight raised
  // it 50 ms later; the partner's swing landed with four ticks of use, one
  // short of a block. A blocked swing bought no time: the next came 2 ticks on.
  for (const partnered of [true, false]) {
    const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 2 });
    const { bot, target, script } = fixture;
    const partner = { ...target, id: 8, kind: "Hostile mobs", position: new Vec3(-3.3, 64, 0) } as Entity;
    if (partnered) bot.entities[partner.id] = partner;
    let killed = false;
    let lowered = 0;
    script.onAttack = () => {
      bot.emit("entityDead", target);
      killed = true;
    };
    const deactivate = bot.deactivateItem;
    bot.deactivateItem = () => {
      if (killed) lowered++;
      deactivate();
    };
    const result = await createCombatController(bot, navigationFixture()).engage(
      target.id,
      new AbortController().signal,
      "hold",
    );
    assert.equal(result.kind, "died");
    assert.equal(lowered > 0, !partnered, partnered ? "the closing partner keeps the guard up" : "an empty field releases it");
    stopCombatFixtureClocks();
  }
});

test("a shielded swing keeps both sides of a nearby pack inside the guard", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 2 });
  const other = { ...fixture.target, id: 8, kind: "Hostile mobs", position: new Vec3(0, 64, 2) } as Entity;
  fixture.bot.entities[other.id] = other;
  fixture.script.onAttack = () => {
    const look = new Vec3(-Math.sin(fixture.bot.entity.yaw), 0, -Math.cos(fixture.bot.entity.yaw));
    for (const entity of [fixture.target, other]) {
      const toward = entity.position.minus(fixture.bot.entity.position).normalize();
      assert.ok(look.dot(toward) > 0.5, "turning directly to one target exposes the other");
    }
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(result.kind, "died");
});

test("combat crouches when knockback leaves its holding position on magma", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.bot.blockAt = (() => ({ name: "magma_block" })) as unknown as Bot["blockAt"];
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const result = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(result.kind, "died");
  assert.ok(fixture.controls.includes("sneak"));
  assert.ok(fixture.controlsCleared.count > 0);
});

test("an exposed cube face still receives contact defense when a ledge hides its centre", async () => {
  const { bot, target } = combatFixture(["iron_sword", "shield"], { targetDistance: 7 });
  const contact = {
    ...target,
    id: 8,
    name: "magma_cube",
    kind: "Hostile mobs",
    isValid: true,
    height: 2.08,
    width: 2.08,
    metadata: [] as Entity["metadata"],
    position: new Vec3(0, 66.6, -0.9),
  } as Entity;
  bot.entities[contact.id] = contact;
  bot.world.raycast = ((_eye: Vec3, _direction: Vec3, distance: number) =>
    distance > 1.1 ? { position: new Vec3(0, 66, -1) } : null) as Bot["world"]["raycast"];
  const attacked: number[] = [];
  bot.attack = (entity) => {
    attacked.push(entity.id);
    bot.emit("entityDead", entity);
    if (entity.id === contact.id) {
      target.position = new Vec3(2, 64, 0);
      // The remaining target walks into the open after the cube dies.
      bot.world.raycast = () => null;
    }
  };
  const result = await createCombatController(bot, navigationFixture()).engage(
    target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.deepEqual(attacked, [contact.id, target.id]);
});

test("an approach yields to a second hostile entering reach before its requested target", async () => {
  const { bot, target } = combatFixture(["iron_sword", "shield"], { targetDistance: 7 });
  const contact = {
    ...target,
    id: 8,
    name: "magma_cube",
    kind: "Hostile mobs",
    isValid: true,
    height: 1.04,
    width: 1.04,
    metadata: [] as Entity["metadata"],
    position: new Vec3(-2, 64, 0),
  } as Entity;
  let approached = 0;
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async (request) => {
      approached++;
      bot.entities[contact.id] = contact;
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: "second hostile entered reach" } as Awaited<
        ReturnType<NavigationRuntime["navigate"]>
      >;
    },
  };
  const attacked: number[] = [];
  bot.attack = (entity) => {
    attacked.push(entity.id);
    bot.emit("entityDead", entity);
    if (entity.id === contact.id) target.position = new Vec3(2, 64, 0);
  };
  const result = await createCombatController(bot, navigation).engage(
    target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(approached, 1);
  assert.deepEqual(attacked, [contact.id, target.id]);
});

for (const alternative of ["stone_axe", null]) {
  test(`a bystander arriving during shield readiness prevents a sword sweep (${alternative ?? "empty hand"})`, async () => {
    const fixture = combatFixture(["iron_sword", "shield", ...(alternative ? [alternative] : [])]);
    const { bot, target } = fixture;
    fixture.script.onWait = () => {
      bot.entities[8] = {
        id: 8,
        name: "zombified_piglin",
        kind: "Hostile mobs",
        isValid: true,
        width: 0.6,
        height: 1.95,
        position: new Vec3(2, 64, 0.7),
      } as Entity;
    };
    fixture.script.onAttack = () => {
      assert.equal(bot.heldItem?.name ?? null, alternative);
      bot.emit("entityDead", target);
    };
    const outcome = await createCombatController(bot, navigationFixture()).engage(
      target.id,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, "died", JSON.stringify(outcome));
    assert.equal(fixture.directAttacks.count, 1);
  });
}

test(
  "a target in reach whose body terrain hides spends a physics tick per decision instead of spinning",
  { timeout: 10_000 },
  async () => {
    const fixture = combatFixture(["iron_sword", "shield"]);
    const { bot, target, clock } = fixture;
    // Every ray from the eyes to the body hits terrain: a blaze in reach behind
    // a fortress pillar. The approach's melee goal is already satisfied, so
    // navigation returns at once, and the step has nothing to await.
    (bot as { world: unknown }).world = { raycast: () => ({ position: new Vec3(1, 64, 0) }) };
    const navigation = {
      ...navigationFixture(),
      navigate: async () => ({ status: "completed", elapsedMs: 0 }) as const,
    };
    fixture.script.onWait = () => {
      if (clock.tick >= 8) target.isValid = false;
    };
    const outcome = await createCombatController(bot, navigation).engage(
      target.id,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, "target_lost", JSON.stringify(outcome));
    assert.equal(fixture.directAttacks.count, 0);
    // Without a tick between decisions the loop never reaches tick 8 and the
    // test times out; with one tick each it ends a decision or two later.
    assert.ok(clock.tick >= 8 && clock.tick <= 12, `ended after ${clock.tick} ticks`);
  },
);

for (const geometry of [
  {
    name: "the observed moving enderman on the slope",
    feet: new Vec3(103.89188043018387, 59, 9.50070927447847),
    target: new Vec3(103.40042749549792, 60, 11.29414146421686),
    bystander: new Vec3(102.64217234166635, 61, 11.620312386678384),
    weapon: "iron_pickaxe",
  },
  {
    name: "a body exactly touching the sweep radius",
    feet: new Vec3(0, 64, 0),
    target: new Vec3(2, 64, 0),
    bystander: new Vec3(3.3, 64, 0),
    weapon: "iron_pickaxe",
  },
  {
    name: "a body outside the sweep radius",
    feet: new Vec3(0, 64, 0),
    target: new Vec3(2, 64, 0),
    bystander: new Vec3(3.4, 64, 0),
    weapon: "iron_sword",
  },
  {
    name: "a body too far above",
    feet: new Vec3(0, 64, 0),
    target: new Vec3(2, 64, 0),
    bystander: new Vec3(0, 67.1, 0),
    weapon: "iron_sword",
  },
  {
    name: "a body too far below",
    feet: new Vec3(0, 64, 0),
    target: new Vec3(2, 64, 0),
    bystander: new Vec3(0, 58, 0),
    weapon: "iron_sword",
  },
]) {
  test(`sword selection respects ${geometry.name}`, async () => {
    const fixture = combatFixture(["iron_sword", "shield", "iron_pickaxe"]);
    fixture.bot.entity.position = geometry.feet;
    fixture.target.position = geometry.target;
    fixture.bot.entities[8] = {
      metadata: [],
      id: 8,
      name: "enderman",
      kind: "Hostile mobs",
      isValid: true,
      width: 0.6,
      height: 2.9,
      position: geometry.bystander,
    } as unknown as Entity;
    fixture.script.onAttack = () => {
      assert.equal(fixture.bot.heldItem?.name, geometry.weapon);
      fixture.bot.emit("entityDead", fixture.target);
    };
    const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
      fixture.target.id,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, "died", JSON.stringify(outcome));
    assert.equal(fixture.directAttacks.count, 1);
  });
}

for (const boundary of ["equipment", "shield readiness", "aim"] as const) {
  test(`reobserves melee reach after ${boundary}`, async () => {
    const fixture = combatFixture(["iron_sword", "shield"]);
    let moved = false;
    const moveTarget = () => {
      if (!moved) fixture.target.position.x = 4;
      moved = true;
    };
    if (boundary === "equipment") {
      const equip = fixture.bot.equip;
      fixture.bot.equip = async (...args) => {
        await equip(...args);
        moveTarget();
      };
    } else if (boundary === "shield readiness") {
      fixture.script.onWait = () => moveTarget();
    } else {
      const lookAt = fixture.bot.lookAt;
      fixture.bot.lookAt = async (...args) => {
        await lookAt(...args);
        moveTarget();
      };
    }
    let approaches = 0;
    const navigation = {
      ...navigationFixture(),
      navigate: async () => {
        approaches += 1;
        fixture.target.position.x = 2;
        return { status: "completed", elapsedMs: 0 } as const;
      },
    };
    let attackDistance = 0;
    fixture.script.onAttack = () => {
      attackDistance = fixture.target.position.distanceTo(fixture.bot.entity.position);
      fixture.bot.emit("entityDead", fixture.target);
    };

    const outcome = await createCombatController(fixture.bot, navigation).engage(
      7,
      new AbortController().signal,
      "pursue",
    );

    assert.equal(outcome.kind, "died");
    assert.equal(approaches, 1);
    assert.ok(attackDistance <= 3, `attack was requested at ${attackDistance} blocks`);
  });
}

test("caller cancellation settles item use and controls before returning", async () => {
  const cancellation = new AbortController();
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.script.onAttack = () => cancellation.abort("test cancellation");

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    cancellation.signal,
    "pursue",
  );

  assert.deepEqual(outcome, {
    kind: "cancelled",
    targetId: 7,
    attacks: 1,
    stylesUsed: ["shielded_melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  });
  assert.equal(fixture.itemUse.at(-1), false);
  assert.equal(fixture.bot.usingHeldItem, false);
  assert.equal(fixture.controlsCleared.count, 1);
  assert.equal(fixture.bot.listenerCount("entitySwingArm"), 0);
});

test("cleanup still clears controls and settles use when the first release throws", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const release = fixture.bot.deactivateItem;
  let releases = 0;
  fixture.bot.deactivateItem = () => {
    releases += 1;
    if (releases === 1) throw new Error("release rejected");
    release();
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") assert.match(outcome.observation, /Combat cleanup failed: release rejected/);
  assert.equal(fixture.controlsCleared.count, 1);
  assert.equal(releases, 2);
  assert.equal(fixture.bot.usingHeldItem, false);
  assert.equal(fixture.bot.listenerCount("entitySwingArm"), 0);
});

test("stop aborts a running engagement and resolves once it has settled", async () => {
  const fixture = combatFixture(["iron_sword"]);
  const controller = createCombatController(fixture.bot, navigationFixture());

  const outcome = controller.engage(7, new AbortController().signal, "pursue");
  await controller.stop("test stop");

  assert.equal((await outcome).kind, "cancelled");
  assert.equal(fixture.controlsCleared.count, 1);
  await controller.stop("nothing to stop");
});

test("holds its ground against a flier and swings when it dives into reach", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10, startingHeld: "iron_sword" });
  fixture.target.name = "phantom";
  fixture.script.onWait = () => {
    // Each tick the phantom closes two blocks; nothing on the ground is asked for a route.
    fixture.target.position = fixture.target.position.offset(-2, 0, 0);
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
  assert.deepEqual(outcome.stylesUsed, ["shielded_melee"]);
  assert.equal(fixture.itemUse[0], true, "the shield goes up while waiting for the dive");
  assert.deepEqual(fixture.controls, []);
});

test("releases the body when a flier circles beyond holding range", async () => {
  const fixture = combatFixture(["iron_sword"], { targetDistance: 20 });
  fixture.target.name = "phantom";

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "unreachable");
  assert.equal(outcome.attacks, 0);
  assert.equal(fixture.controlsCleared.count, 1);
});

test("reports a target no route reached as unreachable rather than failed", async () => {
  const fixture = combatFixture(["iron_sword"], { targetDistance: 10 });
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => ({ status: "stopped", reason: "no path; closest node was 9,64,0", elapsedMs: 1 }),
  } as unknown as NavigationRuntime;

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "unreachable");
  assert.equal(
    outcome.kind === "unreachable" ? outcome.observation : "",
    "Combat approach stopped: no path; closest node was 9,64,0.",
  );
  assert.equal(fixture.controlsCleared.count, 1);
});

for (const threat of ["gap-exposed charge", "incoming fireball"] as const) {
  test(`a hidden charged blaze lets an excavation turn finish, but ${threat} still interrupts`, async () => {
    const fixture = combatFixture(["diamond_sword", "diamond_pickaxe", "shield"], { targetDistance: 8 });
    fixture.bot.entity.width = 0.6;
    fixture.bot.entity.height = 1.8;
    fixture.target.name = "blaze";
    fixture.target.metadata = [];
    const flag = fixture.bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
    Reflect.set(fixture.target.metadata, flag, 1);
    let hidden = true;
    fixture.bot.world.raycast = ((_eye, direction, distance) => {
      // The opening reveals only the nearest face at eye height, while the
      // ray toward the blaze's centre remains blocked. Short projectile rays
      // on the bot's side of the wall remain clear.
      if (distance <= 3 || (!hidden && Math.abs(direction.y) < 0.01)) return null;
      return { position: new Vec3(1, 65, 0) };
    }) as Bot["world"]["raycast"];
    const stop = new AbortController();
    let routes = 0;
    let stayedOnDig = false;
    let guardedOpening = false;
    const navigation: NavigationRuntime = {
      ...navigationFixture(),
      navigate: async (options) => {
        routes++;
        // Navigation looks away from the target to dig its approach step.
        fixture.bot.entity.yaw = Math.PI / 2;
        fixture.bot.emit("physicsTick");
        stayedOnDig = options.stopSignal?.aborted === false;
        if (threat === "gap-exposed charge") hidden = false;
        else
          fixture.bot.entities[8] = Object.assign({}, fixture.target, {
            id: 8,
            name: "small_fireball",
            width: 0.3125,
            position: new Vec3(0, 65, 3),
            velocity: new Vec3(0, 0, -0.5),
          });
        fixture.bot.emit("physicsTick");
        guardedOpening = options.stopSignal?.aborted === true;
        stop.abort("observations complete");
        return { status: "stopped", reason: "probe complete", elapsedMs: 1 };
      },
    };
    await createCombatController(fixture.bot, navigation).engage(7, stop.signal, "pursue");
    assert.equal(routes, 1);
    assert.equal(stayedOnDig, true, "an occluded charging flag must not cancel the dig");
    assert.equal(guardedOpening, true, `${threat} restores the defensive interruption`);
  });
}

test("a guarded approach stops for a draw from outside the shield's arc, meets it facing, and walks on after", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10 });
  // Looking south along the route while the skeleton is east: outside the arc.
  fixture.bot.entity.yaw = 0;
  const skeleton = armWithBow(fixture.target);
  const stops: string[] = [];
  let ticks = 0;
  fixture.script.onWait = () => {
    ticks += 1;
    // The draw the route was stopped for clears after a few ticks.
    if (ticks >= 6) skeleton.drawing(false);
  };
  let routes = 0;
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async (options: { stopSignal?: AbortSignal }) => {
      routes += 1;
      if (routes === 1) {
        // Two blocks into the walk the skeleton starts drawing.
        fixture.bot.entity.position = new Vec3(2, 64, 0);
        fixture.bot.entity.yaw = 0;
        skeleton.drawing(true);
        fixture.bot.emit("physicsTick");
        if (options.stopSignal?.aborted) stops.push(String(options.stopSignal.reason));
        return { status: "stopped", reason: String(options.stopSignal?.reason), elapsedMs: 1 };
      }
      fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.deepEqual(stops, ["ranged volley needs combat facing"]);
  assert.equal(routes, 2, "the walk resumed with the shield facing the target");
  assert.equal(outcome.kind, "died", "the stop was not mistaken for an unreachable target");
  assert.ok(outcome.projectileGuards >= 1, "the volley was met with the shield");
  assert.ok(fixture.timeline.indexOf("shield-up") < fixture.timeline.indexOf("attack"));
});

test("an arrow interrupts construction and waits for its cleanup before returning control", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  let imminent = false;
  const timeline: string[] = [];
  const scene = {
    bot: fixture.bot,
    navigation: { ...navigationFixture(), releaseForTakeover: () => timeline.push("release_requested") },
    signal: new AbortController().signal,
    footingRecovery: { needed: false },
    reportDecision: () => {},
  } as unknown as ConstructorParameters<typeof FightMovement>[0];
  const weapons = {
    currentLoadout: () => ({ shield: {} }),
    projectileDefence: () => imminent ? { imminent: true, projectiles: [], coversAll: true, aligned: false } : null,
  } as unknown as ConstructorParameters<typeof FightMovement>[1];
  const movement = new FightMovement(scene, weapons);
  const before = fixture.bot.listenerCount("physicsTick");
  const result = await movement.positionEffect(async (signal) => {
    try {
      imminent = true;
      fixture.bot.emit("physicsTick");
      signal.throwIfAborted();
      assert.fail("Construction must stop when the arrow is observed");
    } finally {
      await Promise.resolve();
      timeline.push("construction_settled");
    }
  });
  timeline.push("returned");
  assert.equal(result.kind, "interrupted");
  assert.deepEqual(timeline, ["release_requested", "construction_settled", "returned"]);
  assert.equal(fixture.bot.listenerCount("physicsTick"), before);
});

for (const name of ["small_fireball", "arrow"]) {
  test(`a guarded approach yields facing to an incoming ${name} from a different direction`, async () => {
    const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10 });
    fixture.bot.entity.width = 0.6;
    fixture.bot.entity.height = 1.8;
    armWithBow(fixture.target);
    const projectile = Object.assign(combatFixture([]).target, {
      id: 8,
      name,
      width: 0.3125,
      position: new Vec3(0, 65, 8),
      velocity: new Vec3(0, 0, -1.5),
    });
    let stopped = false;
    let routes = 0;
    let metProjectile = false;
    const lookAt = fixture.bot.lookAt;
    fixture.bot.lookAt = async (point, force) => {
      await lookAt(point, force);
      if (stopped && fixture.bot.entities[8] && point.z > fixture.bot.entity.position.z) {
        metProjectile = true;
        delete fixture.bot.entities[8];
      }
    };
    const navigation = {
      ...navigationFixture(),
      cancel: () => undefined,
      navigate: async (options: { stopSignal?: AbortSignal }) => {
        if (++routes === 1) {
          fixture.bot.entity.yaw = -Math.PI / 2;
          fixture.bot.entities[8] = projectile;
          fixture.bot.emit("physicsTick");
          stopped = options.stopSignal?.aborted ?? false;
          return { status: "stopped", reason: "crossfire", elapsedMs: 1 };
        }
        assert.equal(metProjectile, true, "do not resume approach before facing the other shooter's projectile");
        fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
        return { status: "completed", elapsedMs: 1 };
      },
    } as unknown as NavigationRuntime;
    fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
    await createCombatController(fixture.bot, navigation).engage(7, new AbortController().signal, "pursue");
    assert.equal(stopped, true, "facing the selected skeleton does not cover the incoming crossfire shot");
    assert.equal(metProjectile, true);
  });
}

test("a draw inside the shield's arc does not stop the walk while the target remains out of reach", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10 });
  // Looking east, straight at the skeleton.
  fixture.bot.entity.yaw = -Math.PI / 2;
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  let routes = 0;
  let stopped = false;
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async (options: { stopSignal?: AbortSignal }) => {
      routes += 1;
      fixture.bot.entity.position = new Vec3(2, 64, 0);
      fixture.bot.emit("physicsTick");
      stopped = options.stopSignal?.aborted ?? false;
      fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  let ticks = 0;
  fixture.script.onWait = () => {
    ticks += 1;
    if (ticks >= 6) skeleton.drawing(false);
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(routes, 1);
  assert.equal(stopped, false, "the walk was not interrupted for a volley it already faced");
  assert.equal(outcome.kind, "died");
});

test("a target that dies during the approach is reported dead, not unreachable", async () => {
  const fixture = combatFixture(["iron_sword"], { targetDistance: 10 });
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
      // An arrow already in flight lands while the route is being planned.
      fixture.bot.emit("entityDead", fixture.target);
      return { status: "stopped", reason: "Entity 7 is not currently observed.", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
});

for (const afterRelease of [1, 13]) {
  test(`an unguarded chase stops on bow draw even when observed again ${afterRelease} ticks later`, async () => {
    const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10 });
    const skeleton = armWithBow(fixture.target);
    let stopped = false;
    const navigation = {
      ...navigationFixture(),
      navigate: async (options: { stopSignal?: AbortSignal }) => {
        skeleton.drawing(true);
        await fixture.bot.waitForTicks(1);
        skeleton.drawing(false);
        // The arrow is now in flight; turn away before the grace period ends.
        await fixture.bot.waitForTicks(afterRelease - 1);
        fixture.bot.entity.yaw = 0;
        await fixture.bot.waitForTicks(1);
        stopped = options.stopSignal?.aborted ?? false;
        fixture.bot.emit("entityDead", fixture.target);
        return { status: "stopped", reason: "target died", elapsedMs: 0 } as const;
      },
    };
    const outcome = await createCombatController(fixture.bot, navigation).engage(
      7,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, "died");
    assert.equal(stopped, true, "a new bow draw must interrupt the unshielded sprint before facing changes");
  });
}

test("a guarded route hands facing to combat on entering melee reach during a volley", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 10 });
  const skeleton = armWithBow(fixture.target);
  let stopped = false;
  const navigation = {
    ...navigationFixture(),
    navigate: async (options: { stopSignal?: AbortSignal }) => {
      skeleton.drawing(true);
      fixture.bot.entity.position = fixture.target.position.offset(-3, 0, 0);
      fixture.bot.entity.yaw = -Math.PI / 2;
      fixture.bot.emit("physicsTick");
      stopped = options.stopSignal?.aborted ?? false;
      return { status: "stopped", reason: String(options.stopSignal?.reason), elapsedMs: 0 } as const;
    },
  };
  fixture.script.onWait = () => skeleton.drawing(false);
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(stopped, true, "hand over while still facing the volley, before navigation can turn away");
  assert.equal(outcome.kind, "died", "combat resumes after the route settles");
  assert.ok(outcome.projectileGuards >= 1, "combat guards the volley before attacking");
});

test("an unguarded approach yields when the moving target enters melee reach", async () => {
  const fixture = combatFixture(["stone_sword"], { targetDistance: 6 });
  let stopped = false;
  const navigation = {
    ...navigationFixture(),
    navigate: async (options: Parameters<NavigationRuntime["navigate"]>[0]) => {
      fixture.target.position = fixture.bot.entity.position.offset(2.5, 0, 0);
      fixture.bot.emit("physicsTick");
      stopped = options.stopSignal?.aborted ?? false;
      return { status: "stopped", reason: "the unfinished step still has not arrived", elapsedMs: 0 } as const;
    },
  };
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(stopped, true, "combat must not wait for a step beyond the moving target");
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
  disposeCombatTestResources();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("combat's approach goal cannot report arrival beyond actual melee reach", async () => {
  const fixture = combatFixture(["iron_sword"]);
  fixture.bot.entity.position = new Vec3(0.01, 64, 0.01);
  fixture.target.position = new Vec3(3.49, 64, 0.99);
  assert.ok(fixture.target.position.distanceTo(fixture.bot.entity.position) > 3);
  let acceptedOutsideReach: boolean | undefined;
  const navigation = {
    ...navigationFixture(),
    navigate: async (options: Parameters<NavigationRuntime["navigate"]>[0]) => {
      const resolved = options.goal.resolve({
        ...observation(),
        position: fixture.bot.entity.position,
        entities: new Map([[7, { id: 7, position: fixture.target.position, width: 0.6, height: 1.8 }]]),
      });
      assert.equal(resolved.kind, "active");
      if (resolved.kind === "active") {
        acceptedOutsideReach = resolved.isSatisfied(
          {
            feet: { x: 0, y: 64, z: 0 },
            remainingScaffolds: 0,
            overlayId: "overlay:0",
          },
          goalTestWorld,
        );
      }
      fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
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
  assert.equal(acceptedOutsideReach, false, "otherwise combat can retry an already satisfied route without waiting");
});

test("an ascending target releases melee navigation and reselects the carried bow", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow"], { targetDistance: 5 });
  let stopped = false;
  const navigation = {
    ...navigationFixture(),
    navigate: async (options: Parameters<NavigationRuntime["navigate"]>[0]) => {
      fixture.target.position = fixture.bot.entity.position.offset(3, 4, 0);
      fixture.bot.emit("physicsTick");
      stopped = options.stopSignal?.aborted ?? false;
      return { status: "stopped", reason: "radius limit 32 reached", elapsedMs: 0 } as const;
    },
  };
  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(stopped, true);
  assert.equal(outcome.kind, "died");
  assert.equal(fixture.shotTicks.length, 1);
  assert.equal(fixture.directAttacks.count, 0);
  assert.ok(outcome.stylesUsed.includes("bow"));
  disposeCombatTestResources();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("a held position reports an obstructed bow instead of retaining the body indefinitely", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow", "shield"], { targetDistance: 8 });
  Object.defineProperty(fixture.bot.world, "raycast", {
    value: () => ({ position: new Vec3(3, 65, 0) }),
  });
  const stop = new AbortController();
  fixture.script.onWait = () => {
    if (fixture.clock.tick > 30) stop.abort("test detected an indefinite hold");
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(7, stop.signal, "hold");
  assert.equal(outcome.kind, "unreachable");
  assert.equal(outcome.attacks, 0);
  assert.deepEqual(fixture.shotTicks, []);
});

for (const bow of [false, true]) {
  test(`an elevated target behind stone must not cancel its approach as melee contact (bow: ${bow})`, async () => {
    const fixture = combatFixture(["iron_sword", ...(bow ? ["bow", "arrow"] : [])]);
    fixture.target.name = "skeleton";
    fixture.target.position.set(0.6, 68, 1.1);
    Object.defineProperty(fixture.bot.world, "raycast", {
      value: () => ({ position: new Vec3(0, 66, 0) }),
    });
    const stop = new AbortController();
    fixture.script.onWait = () => {
      if (fixture.clock.tick > 30) stop.abort();
    };
    let approaches = 0;
    const result = await createCombatController(fixture.bot, {
      ...navigationFixture(),
      navigate: async (options) => {
        approaches++;
        assert.equal(options.stopSignal?.aborted, false, "stone between bodies prevents melee contact");
        return { status: "stopped", reason: "fixture route unavailable", elapsedMs: 0 };
      },
    }).engage(fixture.target.id, stop.signal, "pursue");
    assert.equal(approaches, 1);
    assert.equal(result.kind, "unreachable", "a real route failure returns instead of looping");
    assert.equal(result.attacks, 0, "do not swing through the ceiling");
  });
}

for (const obstructionTick of [0, 10, 20]) {
  test(`terrain obstructing a bow at draw tick ${obstructionTick} cancels without release and approaches`, async () => {
    const fixture = combatFixture(["iron_sword", "bow", "arrow"], { targetDistance: 8 });
    let cleared = false;
    let approached = false;
    Object.defineProperty(fixture.bot.world, "raycast", {
      value: (_eye: Vec3, direction: Vec3, range: number) => {
        assert.ok(Math.abs(direction.norm() - 1) < 0.000001);
        assert.ok(range > 0 && range <= 3, "each clear-shot ray covers one arrow tick or its final fraction");
        return !cleared && fixture.clock.tick >= obstructionTick ? { position: new Vec3(3, 65, 0) } : null;
      },
    });
    const navigation = {
      ...navigationFixture(),
      navigate: async (options: Parameters<NavigationRuntime["navigate"]>[0]) => {
        approached = true;
        assert.equal(fixture.bot.usingHeldItem, false, "draw must be cancelled before movement");
        assert.deepEqual(fixture.shotTicks, [], "cancelling must not release an arrow");
        assert.equal(options.stopSignal?.aborted, false, "a carried bow alone cannot stop the obstructed approach");
        cleared = true;
        fixture.bot.emit("physicsTick");
        assert.equal(options.stopSignal?.aborted, true, "clear bow range returns physical ownership to combat");
        return { status: "stopped", reason: "combat requested a stop", elapsedMs: 0 } as const;
      },
    };
    fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);
    const outcome = await createCombatController(fixture.bot, navigation).engage(
      7,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, "died");
    assert.equal(approached, true);
    assert.equal(outcome.attacks, 1);
    assert.equal(fixture.shotTicks.length, 1);
    assert.equal(fixture.timeline.filter((entry) => entry.startsWith("slot:")).length, obstructionTick === 0 ? 0 : 2);
  });
}

test("a distant equal-height bow release uses the compensated launch direction", async () => {
  const fixture = combatFixture(["bow", "arrow"], { targetDistance: 24 });
  let lookedAt = new Vec3(0, 0, 0);
  const lookAt = fixture.bot.lookAt;
  fixture.bot.lookAt = async (point, force) => {
    lookedAt = point.clone();
    await lookAt(point, force);
  };
  fixture.script.onShot = () => {
    assert.ok(lookedAt.y > fixture.bot.entity.position.y + 1.62, "release must point upward to compensate arrow drop");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(fixture.shotTicks.length, 1);
});

for (const species of ["skeleton", "blaze"]) {
  for (const rise of [-3, 3]) {
    test(`${species} approach keeps a valid route across a ${rise}-block staircase`, async () => {
      const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 14 });
      fixture.target.name = species;
      fixture.target.metadata = [];
      if (species === "skeleton") Object.defineProperty(fixture.target, "heldItem", { value: { name: "bow" } });
      fixture.bot.entity.position.set(6.5, 64, 0.5);
      fixture.bot.entity.onGround = true;
      fixture.bot.entity.velocity = new Vec3(0, 0, 0);
      let rejectedHeight = false;
      const navigation: NavigationRuntime = {
        ...navigationFixture(),
        navigate: async (options) => {
          // Navigation owns the traversability verdict. A supported staircase
          // must not be reclassified as unreachable solely for changing height.
          fixture.bot.entity.position.set(6.5, 64 + rise, 0.5);
          fixture.bot.emit("physicsTick");
          rejectedHeight = options.stopSignal?.aborted === true;
          fixture.bot.emit("entityDead", fixture.target);
          return { status: "completed", elapsedMs: 1 };
        },
      };
      const result = await createCombatController(fixture.bot, navigation).engage(
        7,
        new AbortController().signal,
        "pursue",
      );
      assert.equal(rejectedHeight, false);
      assert.equal(result.kind, "died");
    });
  }
}

test("an explosive projectile suspends the guard, is deflected, and resumes the same quarry", async () => {
  const { bot, target, script } = combatFixture(["iron_sword", "shield"]);
  bot.health = 20;
  bot.entity.height = 1.8;
  let spawned = false;
  let reflected = false;
  const stop = new AbortController();
  let ticks = 0;
  script.onWait = () => {
    if (++ticks === 100) stop.abort("Deflection and one resumed melee turn did not settle in the fixture.");
    if (spawned) return;
    spawned = true;
    bot.entities[99] = Object.assign({}, target, {
      id: 99,
      name: "fireball",
      width: 1,
      height: 1,
      position: bot.entity.position.offset(1.5, 1, 0),
      velocity: new Vec3(-0.5, 0, 0),
    });
  };
  bot.attack = (entity) => {
    if (entity.id === 99) {
      reflected = true;
      entity.velocity = new Vec3(0.5, 0, 0);
      bot._client.emit("explosion", {});
    } else {
      assert.ok(reflected, "the quarry is attacked only after deflection");
      bot.emit("entityDead", target);
    }
  };
  const controller = createCombatController(bot, navigationFixture());
  let decisions = 0;
  controller.onDecision((event) => {
    if (event.kind === "response" && JSON.stringify(event.evidence).includes('"purpose"') && ++decisions > 12)
      stop.abort("Repeated response decisions without a settled deflection.");
  });
  const explosionListeners = bot._client.listenerCount("explosion");
  const result = await controller.engage(target.id, stop.signal, "hold");
  assert.equal(result.kind, "died", JSON.stringify({ result, spawned, reflected, ticks }));
  assert.equal(result.targetId, target.id);
  assert.equal(controller.activeEngagement(), null);
  assert.equal(result.attacks, 1);
  assert.equal(result.explosions, 1, "the engagement retains explosions while its fight is suspended for deflection");
  assert.equal(bot._client.listenerCount("explosion"), explosionListeners, "the engagement releases its observation");
});

test("dragon breath releases an ordinary mob guard before the dragon reflex claims the body", async () => {
  const { bot, target, script } = combatFixture(["bow", "arrow", "shield"]);
  bot.entity.height = 1.8;
  target.name = "blaze";
  target.position = bot.entity.position.offset(0, 0, 8);
  target.metadata = [];
  Reflect.set(target.metadata, bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags"), 1);
  script.onWait = () => {
    bot.entities[99] = Object.assign({}, target, {
      id: 99,
      name: "area_effect_cloud",
      position: bot.entity.position.clone(),
      metadata: { 8: 5, 10: { type: "dragon_breath" } },
    });
  };
  const controller = createCombatController(bot, navigationFixture());
  const result = await controller.engage(target.id, new AbortController().signal, "hold");
  assert.equal(result.kind, "defence_required");
  if (result.kind !== "defence_required") throw new Error(JSON.stringify(result));
  assert.match(result.observation, /Dragon hazard/);
  assert.equal(controller.activeEngagement(), null);
  assert.equal(result.attacks, 0);
});

test("changing the withdrawal budget settles an active End escape before publishing the edit", async () => {
  const { bot, target } = combatFixture(["shield"]);
  bot.health = 20;
  bot.food = 20;
  bot.entity.height = 1.8;
  bot.entity.onGround = true;
  bot.entities[99] = Object.assign({}, target, {
    id: 99,
    name: "area_effect_cloud",
    position: bot.entity.position.clone(),
    metadata: { 8: 5, 10: { type: "dragon_breath" } },
  });
  let notifyNavigation!: () => void;
  const navigating = new Promise<void>((resolve) => {
    notifyNavigation = resolve;
  });
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        notifyNavigation();
      }),
  };
  const controller = createCombatController(bot, navigation);
  const escape = controller.runEnd({ kind: "evade" }, new AbortController().signal);
  const cancelled = assert.rejects(escape, /Combat policy changed/);
  await navigating;
  await editPolicy(controller, { combat: { evade_timeout_ms: 5_000 } });
  await cancelled;
  assert.equal(controller.activeEngagement(), null);
  assert.equal(controller.policy.settling, false);
  assert.equal(controller.policy.combat.evade_timeout_ms, 5_000);
});

test("carrying a shield does not slow a clear chase between volleys", async () => {
  const fixture = combatFixture(["iron_sword", "shield"], { targetDistance: 8 });
  let approaches = 0;
  const navigation = {
    ...navigationFixture(),
    navigate: async (options: Parameters<NavigationRuntime["navigate"]>[0]) => {
      approaches++;
      assert.equal(options.movements?.allowSprinting, true);
      assert.equal(fixture.bot.usingHeldItem, false);
      fixture.target.position.x = 2;
      return { status: "completed", elapsedMs: 0 } as const;
    },
  };
  fixture.script.onAttack = () => {
    assert.equal(fixture.bot.usingHeldItem, true, "restore guard for contact");
    fixture.bot.emit("entityDead", fixture.target);
  };
  const result = await createCombatController(fixture.bot, navigation).engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "died");
  assert.equal(approaches, 1);
});
