import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { TestEndCombat as EndCombat } from "../../../test-support/combat.js";
import type { FootingRecovery } from "../footing.js";

import { botFixture } from "../../../test-support/bot.js";
import { flatWorld } from "../../../test-support/navigation.js";
import { physicsEveryMillisecond } from "../../../test-support/physics.js";
import { CrystalObservation } from "../../perception/combat/crystal.js";
import { PerchObservation } from "../../perception/combat/perch.js";

/** No footing recovery is pending in these fixtures. */
const steady = { needed: false } as FootingRecovery;

/** The dragon (id 42) at the origin; metadata 9 is its health and 16 its phase (6 is perched). */
function dragon(phase: number, { health = 200, y = 68, yaw = 0 } = {}) {
  return {
    id: 42, name: "ender_dragon", isValid: true,
    position: new Vec3(0, y, 0), velocity: new Vec3(0, 0, 0), yaw,
    metadata: { 9: health, 16: phase },
  } as unknown as Bot["entity"] & { metadata: any };
}

/** A dragon-breath area effect cloud; metadata 8 is its radius. */
function breathCloud(id: number, position: Vec3, radius: number) {
  return {
    id, name: "area_effect_cloud", isValid: true, position,
    metadata: { 8: radius, 10: { type: "dragon_breath" } },
  } as unknown as Bot["entity"];
}

test("perch diagnostics explain cloud-rejected endpoints without attempting navigation", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(30.5, 63, 0.5) },
    { clearControlStates: () => {}, deactivateItem: () => {} });
  bot.entities[42] = dragon(6);
  for (const y of [61, 63, 65, 67]) bot.entities[y] = breathCloud(y, new Vec3(0, y, 6.5), 20);
  const caller = new AbortController();
  let reported = false;
  const listeners = bot.listenerCount("physicsTick");
  using observation = new PerchObservation(bot, 42);
  const navigation = { navigate: () => assert.fail("geometry rejected all endpoints") } as unknown as NavigationRuntime;
  await assert.rejects(new EndCombat(bot, navigation, steady, facts => {
    const event = JSON.parse(JSON.stringify(facts));
    if (event.reason !== "no_safe_striking_position") return;
    reported = true;
    assert.equal(event.digPermitted, true);
    assert.equal(event.nativePhase, 6);
    assert.equal(event.details.candidates.usable, 0);
    assert.ok(event.details.candidates.cloudBlocked > 0);
    assert.equal(event.currentCloudExposure, 0, "the bot is safe but all strike endpoints are clouded");
    caller.abort(new Error("diagnosis captured"));
  }).perch(42, caller.signal, observation), /diagnosis captured/);
  assert.equal(reported, true);
  assert.equal(bot.listenerCount("physicsTick"), listeners + 1, "only the still-owned observation listener remains");
});

test("perch diagnostics retain a cached route failure and explain its retry condition", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(12.5, 64, 0.5) },
    { clearControlStates: () => {}, deactivateItem: () => {} });
  bot.entities[42] = dragon(6);
  const caller = new AbortController();
  let routes = 0, cached = false;
  const navigation = { navigate: async () => { routes++; return { status: "failed", reason: "no path fixture" }; } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  using _physics = physicsEveryMillisecond(bot);
  await assert.rejects(new EndCombat(bot, navigation, steady, facts => {
    const event = JSON.parse(JSON.stringify(facts));
    if (event.reason !== "cached_route_failure") return;
    cached = true;
    assert.match(event.details.failure, /no path fixture/);
    assert.match(event.details.retryWhen, /head moves/);
    caller.abort(new Error("cached diagnosis captured"));
  }).perch(42, caller.signal, observation), /cached diagnosis captured/);
  assert.equal(cached, true);
  assert.equal(routes, 2, "try the head, then the body union once before waiting");
});

test("a cloud-blocked head searches safe body reach and swings the reached native part", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(12.5, 64, 0.5),
    items: [{ name: "diamond_sword", count: 1 }] },
    { clearControlStates: () => {}, deactivateItem: () => {}, lookAt: async () => {} });
  bot.entities[42] = dragon(6);
  for (const y of [62, 64, 66]) bot.entities[y] = breathCloud(y, new Vec3(0, y, 6.5), 5);
  const caller = new AbortController();
  let routes = 0, swings = 0;
  bot.attack = part => {
    assert.equal(part.id, 45, "body is parent + 3, not the head or root");
    swings++;
    caller.abort(new Error("body swing observed"));
  };
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    routes++;
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.match(resolved.revision, /^dragon-body:/);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 64, z: -2 } } as never, {} as never), true);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 64, z: 6 } } as never, {} as never), false);
    }
    bot.entity.position.set(0.5, 64, -1.5);
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  using _physics = physicsEveryMillisecond(bot);
  await assert.rejects(new EndCombat(bot, navigation, steady)
    .perch(42, caller.signal, observation), /body swing observed/);
  assert.equal(routes, 1, "do not restart head pursuit after reaching the body");
  assert.equal(swings, 1);
});

test("a late scanning request still pursues the head rather than preparing a tunnel", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(12.5, 64, 0.5) },
    { clearControlStates: () => {}, deactivateItem: () => {} });
  bot.entities[42] = dragon(6);
  using observation = new PerchObservation(bot, 42);
  for (let t = 0; t < 75; t++) bot.emit("physicsTick");
  const caller = new AbortController();
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") assert.match(resolved.revision, /^dragon-head:/);
    caller.abort(new Error("head pursuit observed"));
    caller.signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  await assert.rejects(new EndCombat(bot, navigation, steady)
    .perch(42, caller.signal, observation), /head pursuit observed/);
});

test("head approach can walk below breath while a jump into the same cloud is refused", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(12.5, 63, 0.5) },
    { clearControlStates: () => {}, deactivateItem: () => {} });
  bot.entities[42] = dragon(6, { yaw: Math.PI / 2 });
  bot.entities[43] = breathCloud(43, new Vec3(9.5, 65, 0.5), 5);
  const caller = new AbortController();
  const navigation = { navigate: async ({ goal, movements }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(resolved.isSatisfied({ feet: { x: 7, y: 63, z: 0 } } as never, {} as never), true);
      assert.equal(resolved.isSatisfied({ feet: { x: 7, y: 69, z: 0 } } as never, {} as never), false);
    }
    assert.equal(movements.decideMovement!("walk", { x: 10, y: 63, z: 0 }, { x: 9, y: 63, z: 0 }).kind, "allowed");
    assert.equal(movements.decideMovement!("drop", { x: 7, y: 69, z: 0 }, { x: 7, y: 63, z: 0 }).kind, "prohibited",
      "safe endpoints do not permit falling through the intervening breath layer");
    assert.equal(movements.decideMovement!("drop", { x: 30, y: 69, z: 0 }, { x: 30, y: 63, z: 0 }).kind, "allowed");
    assert.equal(movements.decideMovement!("step_up", { x: 10, y: 63, z: 0 }, { x: 9, y: 64, z: 0 }).kind, "prohibited");
    assert.equal(movements.decideMovement!("step_up", { x: 20, y: 64, z: 0 }, { x: 19, y: 65, z: 0 }).kind, "prohibited",
      "a route must not climb above its low strike height even outside current contact boxes");
    caller.abort(new Error("cloud route checked"));
    caller.signal.throwIfAborted();
  } } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  await assert.rejects(new EndCombat(bot, navigation, steady)
    .perch(42, caller.signal, observation), /cloud route checked/);
});

test("a fireball dodge clears the growing cloud horizontally rather than dropping into a nearby shaft", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(0.5, 64, 0.5) });
  bot.entities[7] = { id: 7, name: "dragon_fireball", isValid: true,
    position: new Vec3(0.5, 65, 30), velocity: new Vec3(0, 0, -1) } as unknown as Bot["entity"];
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(resolved.isSatisfied({ feet: { x: 8, y: 64, z: 0 } } as never, {} as never), false);
      assert.equal(resolved.isSatisfied({ feet: { x: 0, y: 54, z: 0 } } as never, {} as never), false);
      assert.equal(resolved.isSatisfied({ feet: { x: 10, y: 64, z: 0 } } as never, {} as never), true);
    }
    bot.entities[7]!.isValid = false;
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  using _physics = physicsEveryMillisecond(bot);
  const result = await new EndCombat(bot, navigation, steady).evade(new AbortController().signal);
  assert.equal(result.outcome, "evaded");
});

test("an ordinary scaffold blocking a resistant shelter sends retreat directly to escape", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(6.5, 63, 1.5),
    blocks: { "6,62,1": "end_stone", "7,63,1": "cobbled_deepslate" },
    items: [{ name: "end_stone", count: 20 }] }, {
    placeBlock: () => assert.fail("Do not start a shelter whose required wall cannot be placed"),
  });
  bot.entities[42] = dragon(4, { y: 67 });
  let moved = false;
  const navigation = { navigate: async () => {
    moved = true;
    bot.entity.position.set(20.5, 63, 1.5);
    return { status: "completed", elapsedMs: 1 };
  } } as unknown as NavigationRuntime;
  using _physics = physicsEveryMillisecond(bot);
  const result = await new EndCombat(bot, navigation, steady).evade(new AbortController().signal);
  assert.equal(result.outcome, "evaded");
  assert.equal(moved, true);
});

test("takeoff observed during suspension still owes retreat, and failed retreat retains damage", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(6.5, 64, 0.5) },
    { clearControlStates: () => {}, deactivateItem: () => {} });
  const perched = dragon(6, { yaw: Math.PI / 2 });
  bot.entities[42] = perched;
  using observation = new PerchObservation(bot, 42);
  observation.swung(13);
  perched.metadata[9] = 193;
  perched.metadata[16] = 4;
  bot.emit("physicsTick");
  const navigation = { navigate: async () => ({ status: "failed", reason: "blocked return" }) } as unknown as NavigationRuntime;
  using _physics = physicsEveryMillisecond(bot);
  const result = await new EndCombat(bot, navigation, steady).perch(42, new AbortController().signal, observation);
  assert.equal(result.outcome, "stopped");
  assert.match(result.reason!, /PERCH_RETREAT_INCOMPLETE.*blocked return/);
  assert.equal(result.attacks, 1);
  assert.equal(result.healthAfter, 193);
  assert.equal(result.perch?.timing?.confirmedDamage, 7);
});

test("breath interrupts a local bite and reaches evasion without swallowing caller cancellation", async () => {
  const bot = botFixture();
  bot.health = 20;
  bot.food = 17;
  bot.entities[42] = dragon(0, { y: 95 });
  bot.inventory.items = () => [{ name: "cooked_beef", count: 1 } as ReturnType<Bot["inventory"]["items"]>[number]];
  bot.equip = async () => {};
  bot.clearControlStates = () => {};
  let cancelBite: () => void = () => {};
  bot.deactivateItem = () => {
    bot.usingHeldItem = false;
    cancelBite();
  };
  bot.consume = () =>
    new Promise<void>((_resolve, reject) => {
      cancelBite = () => reject(new Error("native consume interrupted"));
      bot.usingHeldItem = true;
      bot.entities[7] = breathCloud(7, bot.entity.position.clone(), 5);
      bot.emit("physicsTick");
    });
  const caller = new AbortController();
  let escapes = 0;
  const navigation = {
    navigate: async () => {
      escapes++;
      assert.equal(bot.usingHeldItem, false);
      caller.abort(new Error("caller cancelled after escape admission"));
      caller.signal.throwIfAborted();
    },
  } as unknown as NavigationRuntime;
  const observation = new PerchObservation(bot, 42);
  await assert.rejects(
    new EndCombat(bot, navigation, steady).perch(42, caller.signal, observation),
    /caller cancelled after escape admission/,
  );
  assert.equal(escapes, 1);
  observation[Symbol.dispose]();
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("waiting for a perch is cancellable and releases entity listeners and controls", async () => {
  const controller = new AbortController();
  let cleared = 0,
    attacks = 0;
  const bot = Object.assign(new EventEmitter(), {
    registry: minecraftData("1.21.4"),
    game: { dimension: "the_end" },
    waitForTicks: async () => {},
    health: 20,
    food: 20,
    inventory: { slots: [], items: () => [] },
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    entities: {
      42: {
        id: 42,
        isValid: true,
        name: "ender_dragon",
        position: new Vec3(0, 90, 0),
        velocity: new Vec3(0, 0, 0),
        metadata: { 9: 200, 16: 0 },
      },
    },

    deactivateItem: () => {},
    clearControlStates: () => {
      cleared++;
    },
    attack: () => {
      attacks++;
    },
  }) as unknown as Bot;
  const navigation = {
    navigate: async () => {
      throw new Error("A flying dragon has no melee approach");
    },
  } as unknown as NavigationRuntime;
  const observation = new PerchObservation(bot, 42);
  observation.preparationTarget = new Vec3(0, 60, 6);
  observation.preparedPosition = observation.preparationTarget.clone();
  bot.entity.position = observation.preparedPosition.clone();
  const pending = new EndCombat(bot, navigation, steady).perch(42, controller.signal, observation);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
  observation[Symbol.dispose]();
  assert.equal(attacks, 0);
  assert.equal(cleared, 1);
  assert.equal(bot.listenerCount("entityDead"), 0);
});

test("a newly observed breath cloud aborts perch sightline digging before any swing", async () => {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(2, 64, 5),
    blocks: { "2,66,4": "end_stone" } }, { clearControlStates: () => {}, deactivateItem: () => {} });
  const perched = dragon(6, { health: 190 });
  bot.entities[42] = perched;
  const obstruction = bot.blockAt(new Vec3(2, 66, 4))!;
  const obstructionHit = Object.assign(obstruction, { intersect: new Vec3(2.25, 66, 4.9) });
  bot.blockAtCursor = () => null;
  bot.world.raycast = (() => obstructionHit) as unknown as Bot["world"]["raycast"];
  let attacks = 0,
    escapes = 0,
    digAborted = false;
  bot.attack = async () => {
    attacks++;
  };
  const caller = new AbortController();
  const navigation = {
    breakBlockInPlace: async ({ signal }: { signal: AbortSignal }) => {
      bot.entities[7] = breathCloud(7, bot.entity.position.clone(), 5);
      bot.emit("physicsTick");
      await new Promise((resolve) => setImmediate(resolve));
      digAborted = signal.aborted;
      signal.throwIfAborted();
      return { status: "broken" };
    },
    navigate: async () => {
      escapes++;
      assert.equal(digAborted, true);
      assert.equal(attacks, 0);
      caller.abort(new Error("stop after danger handling"));
      caller.signal.throwIfAborted();
    },
  } as unknown as NavigationRuntime;
  const observation = new PerchObservation(bot, 42);
  try {
    await assert.rejects(
      new EndCombat(bot, navigation, steady).perch(42, caller.signal, observation),
      /stop after danger handling/,
    );
    assert.equal(digAborted, true);
    assert.equal(escapes, 1);
    assert.equal(attacks, 0);
  } finally {
    observation[Symbol.dispose]();
  }
});

test("End escape waits for the observed landing before asking navigation for a route", async () => {
  const bot = botFixture();
  bot.health = 20;
  bot.entity.onGround = false;
  bot.entities[7] = breathCloud(7, new Vec3(0.5, 64, 0.5), 5);
  let ticks = 0,
    calls = 0;
  using _physics = physicsEveryMillisecond(bot, () => {
    ticks++;
    bot.entity.onGround = true;
  });
  const navigation = {
    navigate: async () => {
      assert.equal(bot.entity.onGround, true);
      assert.ok(ticks > 0);
      calls++;
      bot.entity.position.set(10, 64, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const result = await new EndCombat(bot, navigation, steady).evade(new AbortController().signal);
  assert.equal(result.outcome, "evaded");
  assert.equal(calls, 1);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a landing escape releases a safe bot when the dragon settles instead of finishing the obsolete route", async () => {
  const bot = botFixture({
    dimension: "the_end", blocks: { "0,63,0": "end_stone" },
    items: [{ name: "end_stone", count: 10 }],
  }, {
    clearControlStates: () => {}, deactivateItem: () => {},
    placeBlock: () => assert.fail("Landing must preserve the prepared head sightline, even with shelter supplies."),
  });
  bot.entity.position.set(0.5, 64, 0.5);
  const landing = dragon(3, { health: 190 });
  bot.entities[42] = landing;
  let moves = 0;
  const navigation = {
    navigate: async ({ stopSignal }: { stopSignal: AbortSignal }) => {
      moves++;
      landing.metadata[16] = 6;
      bot.emit("physicsTick");
      assert.equal(stopSignal.aborted, true, "the now-safe approach must not be carried away from the head");
      return { status: "cancelled", reason: "landing ended" };
    },
  } as unknown as NavigationRuntime;
  using _physics = physicsEveryMillisecond(bot);
  const result = await new EndCombat(bot, navigation, steady).evade(new AbortController().signal);
  assert.equal(result.outcome, "evaded");
  assert.equal(moves, 1);
});

test("damage-interrupted breath excavation gives the next escape a route without digging", async () => {
  const bot = botFixture();
  bot.health = 20;
  bot.entity.onGround = true;
  bot.entities[7] = breathCloud(7, bot.entity.position.clone(), 5);
  const footing = {
    needed: false,
    async recover() {
      Object.assign(footing, { needed: false });
      return "landed";
    },
  } as unknown as FootingRecovery;
  using _physics = physicsEveryMillisecond(bot);
  let attempts = 0;
  const navigation = {
    async navigate(options: Parameters<NavigationRuntime["navigate"]>[0]) {
      attempts++;
      assert.equal(
        options.movements.allowPlacing,
        false,
        "escape must not extend an aerial bridge under dragon contact",
      );
      assert.equal(options.movements.scaffold, null);
      if (attempts === 1) {
        assert.equal(options.movements.allowDigging, true);
        bot.health = 17;
        Object.assign(footing, { needed: true });
        bot.emit("physicsTick");
        assert.equal(options.stopSignal?.aborted, true);
        return { status: "stopped", reason: "knockback", elapsedMs: 500 } as const;
      }
      assert.equal(options.movements.allowDigging, false, "do not restart the same vulnerable excavation");
      assert.equal(footing.needed, false, "the next route still waits for physical recovery");
      bot.entities[7]!.isValid = false;
      return { status: "completed", elapsedMs: 500 } as const;
    },
  } as unknown as NavigationRuntime;
  const result = await new EndCombat(bot, navigation, footing).evade(new AbortController().signal);
  assert.equal(result.outcome, "evaded");
  assert.equal(attempts, 2);
});

/**
 * Staircase fight of 21 October (run 2026-10-21T22-50-17-456Z-t00006): after
 * the last crystal, the walk back to 9,64,-14 crossed the fountain while the
 * dragon sat on it. The return route stepped up from -5,63,1 to -5,64,0, into
 * the perched wing's reach; the escape stepped one block down again, and the
 * two handed the body back and forth for 15 s until the take-off launched it
 * to y 125. These are the recorded perch pose and the cell the escape left.
 */
function staircaseReturn(onRoute: (movements: Parameters<NavigationRuntime["navigate"]>[0]["movements"], call: number) => boolean) {
  const bot = botFixture({ dimension: "the_end", position: new Vec3(-4.5, 63, 1.45), groundY: 62 },
    { clearControlStates: () => {}, deactivateItem: () => {}, _client: new EventEmitter() });
  const perched = dragon(5, { yaw: 0.6135923151542566 });
  perched.position.set(-0.027594914940232584, 67.26512656614356, 0.13981359499631196);
  bot.entities[42] = perched;
  bot.entities[40] = { id: 40, name: "end_crystal", isValid: false, position: new Vec3(-12.5, 98, 39.5) } as unknown as Bot["entity"];
  let routes = 0;
  const navigation = {
    world: flatWorld(),
    navigate: async ({ goal, movements }: Parameters<NavigationRuntime["navigate"]>[0]) => {
      routes++;
      const resolved = goal.resolve({} as never);
      assert.equal(resolved.kind, "active");
      if (resolved.kind === "active") assert.match(resolved.revision, /^crystal-return:9,64,-14/);
      if (!onRoute(movements, routes)) return { status: "failed", reason: "no path fixture", elapsedMs: 1 } as const;
      bot.entity.position.set(9.5, 64, -13.5);
      return { status: "completed", elapsedMs: 1 } as const;
    },
  } as unknown as NavigationRuntime;
  const observation = new CrystalObservation(bot, 40, "melee");
  observation.destroyed = true;
  observation.meleeReturn = new Vec3(9, 64, -14);
  return { bot, perched, observation, end: new EndCombat(bot, navigation, steady), routes: () => routes };
}

test("the crystal return keeps out of the perched dragon's wing reach it stepped into", async () => {
  const world = flatWorld();
  const f = staircaseReturn((movements) => {
    assert.equal(movements.decideStep(-5, 64, 0, world).kind, "prohibited",
      "the recorded step-up cell lies inside the perched wing's knockback box");
    assert.equal(movements.decideMovement?.("step_up", { x: -5, y: 63, z: 1 }, { x: -5, y: 64, z: 0 }).kind, "prohibited");
    assert.notEqual(movements.decideStep(-4, 63, 2, world).kind, "prohibited", "a block lower, the wing does not reach");
    assert.equal(movements.decideMovement?.("walk", { x: -5, y: 63, z: 1 }, { x: -4, y: 63, z: 2 }).kind ?? "allowed", "allowed");
    return true;
  });
  using observation = f.observation;
  using _physics = physicsEveryMillisecond(f.bot);
  const result = await f.end.crystal(40, new AbortController().signal, observation);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.crystal?.melee.returnedToGround, true);
  assert.equal(f.routes(), 1);
});

test("a crystal return that the perched wings close waits for the perch to change, not stops", async () => {
  const f = staircaseReturn((_movements, call) => {
    if (call === 1) {
      // The dragon turns its wings away while the body holds its clear cell.
      setTimeout(() => { f.perched.yaw = 0.6135923151542566 + Math.PI / 2; }, 20);
      return false;
    }
    return true;
  });
  using observation = f.observation;
  using _physics = physicsEveryMillisecond(f.bot);
  const result = await f.end.crystal(40, new AbortController().signal, observation);
  assert.equal(result.outcome, "crystal_destroyed", result.reason ?? "");
  assert.equal(f.routes(), 2);
});
