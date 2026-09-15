import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { MemoryWorld as GoalTestWorld } from "../../../navigation/world/memory-world.js";
import {
  TestCombatPosition as CombatPosition,
  combatResourceRefusalForTest as combatResourceRefusal,
  createTestCombatController as createCombatController,
  disposeCombatTestResources,
} from "../../../test-support/combat.js";
import { ScriptedBlaze } from "../../../test-support/scripted-blaze.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { type CombatDecision } from "./contract.js";

import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { observation } from "../../../test-support/navigation.js";
import { positionWorld } from "../../positioning/combat/geometry.js";
import { findCombatPosition } from "../../positioning/combat/planner.js";
import { retreatFromCreepers } from "../../responses/fight/creeper-retreat.js";
import { guardRetreatProjectiles } from "../../weapons/projectile-guard.js";

import { SupportedPositionHold } from "../../../navigation/index.js";
import { CombatPerception, positionThreat } from "../../perception/combat/observations.js";
import { incomingShieldProjectiles } from "../../perception/combat/shield-projectiles.js";
import { FootingRecovery } from "../../responses/footing.js";
import { botFixture } from "../../../test-support/bot.js";
import { PerchObservation } from "../../perception/combat/perch.js";
import { FightMovement } from "../../responses/fight/movement.js";
import { projectileShieldFacing, shieldFacing } from "../../weapons/shield-facing.js";

const goalTestWorld = new GoalTestWorld();
const fixtureClocks = new Set<() => void>();
afterEach(() => {
  for (const stop of fixtureClocks) stop();
  fixtureClocks.clear();
});

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
  await controller.policy.edit({ operation: "set", expected_revision: controller.policy.snapshot().revision,
    changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "cook the meat" });
  await cancelled;
  assert.equal(bot.usingHeldItem, false);
  assert.equal(controller.activeEngagement(), null);
  assert.equal(controller.policy.settling, false);
  assert.equal(bot.inventory.items()[0]?.count, 2);
});

test("shield-only defence observes target death before requesting another guard", async () => {
  const fixture = combatFixture(["shield"]);
  const controller = createCombatController(fixture.bot, navigationFixture());
  await controller.policy.edit({
    operation: "set",
    expected_revision: controller.policy.snapshot().revision,
    changes: { combat: { melee: false, bow: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });
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
  await controller.policy.edit({
    operation: "set",
    expected_revision: controller.policy.snapshot().revision,
    changes: { combat: { recover: "never" } },
    lifetime: { kind: "session" },
    reason: "test",
  });
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
  await controller.policy.edit({
    operation: "set",
    expected_revision: controller.policy.snapshot().revision,
    changes: { combat: { recover: "never" } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  const result = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "capability_blocked");
  assert.equal(fixture.bot.listenerCount("health"), 0);
});

type CombatScript = {
  onWait?: (ticks: number) => void;
  onAttack?: () => void;
  onShot?: () => void;
};

type Entity = Parameters<Bot["attack"]>[0];

/** These defense fixtures use target #7; a real bot-directed hit authorizes
 * their guard. Anger metadata alone also covers Endermen fighting the dragon. */
function controllerAfterObservedHit(bot: Bot, navigation: NavigationRuntime) {
  const perception = new CombatPerception(bot);
  const controller = createCombatController(bot, navigation, perception);
  bot.emit("entityHurt", bot.entity, bot.entities[7]!);
  return {
    ...controller,
    async engage(...args: Parameters<typeof controller.engage>) {
      try {
        return await controller.engage(...args);
      } finally {
        perception[Symbol.dispose]();
      }
    },
  };
}

function blazePreflightFixture(items: readonly string[]) {
  const fixture = combatFixture(items);
  fixture.bot.entity.position.set(0.5, 64, 0.5);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  fixture.target.name = "blaze";
  fixture.target.kind = "Hostile mobs";
  fixture.target.position.set(0.5, 64, -8);
  const world = new MemoryWorld();
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++)
      for (let y = 63; y <= 72; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  const navigation = { ...navigationFixture(), world };
  return { ...fixture, world, navigation };
}

for (const blocks of [0, 1]) {
  test(`skeleton crossfire with ${blocks} building blocks keeps guarded combat available`, async () => {
    const fixture = blazePreflightFixture(["iron_sword", "shield", "cobblestone"]);
    const { bot, target } = fixture;
    target.name = "skeleton";
    armWithBow(target);
    bot.inventory.items().find((item) => item.name === "cobblestone")!.count = blocks;
    bot.entities[8] = Object.assign(combatFixture([]).target, target, { id: 8, position: new Vec3(0.5, 64, 8.5) });
    assert.equal(new CombatPosition(bot, fixture.navigation, target, new Set()).planCover().kind, "materials_missing");
    let approaches = 0;
    const navigation = {
      ...fixture.navigation,
      navigate: async () => {
        approaches++;
        bot.entity.position = target.position.offset(0, 0, 2);
        return { status: "completed", elapsedMs: 1 };
      },
    } as NavigationRuntime;
    bot.placeBlock = async () => assert.fail("Unaffordable cover must not start construction");
    fixture.script.onAttack = () => bot.emit("entityDead", target);
    const result = await createCombatController(bot, navigation).engage(7, new AbortController().signal, "pursue");
    assert.equal(result.kind, "died");
    assert.ok(approaches > 0);
    assert.ok(fixture.timeline.includes("shield-up"));
  });
}

test("blaze admission prices the whole cover before any aim, equipment or movement", () => {
  const fixture = blazePreflightFixture(["iron_sword", "cobblestone"]);
  const { bot, target, navigation } = fixture;
  const blocks = bot.inventory.items().find((item) => item.name === "cobblestone")!;
  blocks.count = 64;
  const planned = new CombatPosition(bot, navigation, target, new Set()).planCover();
  assert.equal(planned.kind, "ready");
  if (planned.kind !== "ready") return;
  const required = planned.plan.placements.length;
  assert.ok(required > 1);
  for (const available of [0, required - 1]) {
    blocks.count = available;
    assert.equal(
      combatResourceRefusal(bot, navigation, target),
      `[COMBAT_BUILD_MATERIALS_MISSING] Defensive cover construction needs ${required} usable building blocks at the selected position; ${available} carried.`,
    );
  }
  blocks.count = required;
  assert.equal(combatResourceRefusal(bot, navigation, target), null);
  assert.deepEqual(fixture.timeline, []);
  assert.deepEqual(fixture.controls, []);
  assert.deepEqual(fixture.equipped, []);
  assert.equal(fixture.clock.tick, 0);
});

test("combat cover uses navigation's standing cell on a lowered soul-sand floor", () => {
  const { bot, target, navigation, world } = blazePreflightFixture(["iron_sword", "cobblestone"]);
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  bot.entity.position.y = 63.875;
  bot.entity.onGround = true;
  const stateId = bot.registry.blocksByName.soul_sand!.defaultState;
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) world.load({ x, y: 63, z }, { stateId });
  const planned = new CombatPosition(bot, navigation, target, new Set()).planCover();
  assert.equal(planned.kind, "ready");
  if (planned.kind === "ready") assert.equal(planned.plan.protected.y, 64);
});

test("roof admission avoids passable twisting vines before provoking an Enderman", () => {
  const { bot, target, navigation, world } = blazePreflightFixture(["iron_sword", "cobblestone"]);
  target.name = "enderman";
  target.height = 2.9;
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  const vines = new Vec3(0, 66, 0);
  world.load(vines, {
    stateId: bot.registry.blocksByName.twisting_vines_plant!.defaultState,
    collisionShapes: [],
    traits: { empty: true },
  });
  const planned = new CombatPosition(bot, navigation, target, new Set()).planRoof({ kind: "protection" });
  assert.equal(planned.kind, "ready");
  if (planned.kind !== "ready") return;
  assert.equal(
    planned.plan.placements.some((cell) => cell.equals(vines)),
    false,
  );
  assert.equal(planned.plan.cell.equals(bot.entity.position.floored()), false);
});

test("a refused cover search cannot renew its construction attempt without changed material", async () => {
  const fixture = blazePreflightFixture(["iron_sword", "cobblestone"]);
  const { bot, target } = fixture;
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  const navigation: NavigationRuntime = {
    ...fixture.navigation,
    world: new MemoryWorld(),
    navigate: async () =>
      ({ status: "stopped", reason: "no reachable cover" }) as Awaited<ReturnType<NavigationRuntime["navigate"]>>,
  };
  const position = new CombatPosition(bot, navigation, target, new Set());
  const footing = new SupportedPositionHold(bot, navigation.world);
  try {
    assert.equal(position.canEstablish, true);
    assert.match((await position.establish(new AbortController().signal, footing))?.reason ?? "", /no reachable cover/);
    assert.equal(position.canEstablish, false, "the same unchanged refusal must not spin");
  } finally {
    footing.release();
  }
});

test("a shield admits one blaze without blocks, but does not admit opposing crossfire", () => {
  const { bot, target, navigation } = blazePreflightFixture(["iron_sword", "shield"]);
  assert.equal(combatResourceRefusal(bot, navigation, target), null);
  const other = Object.assign({}, target, { id: 8, position: new Vec3(0.5, 64, 8) });
  bot.entities[other.id] = other;
  assert.match(combatResourceRefusal(bot, navigation, target) ?? "", /COMBAT_BUILD_MATERIALS_MISSING/);
  other.position.set(1.5, 64, -8);
  assert.equal(combatResourceRefusal(bot, navigation, target), null, "one shield can cover aligned shooters");
});

test("existing blaze cover needs no carried blocks, and unavailable geometry is not a material shortage", () => {
  const { bot, target, navigation, world } = blazePreflightFixture(["iron_sword", "cobblestone"]);
  const blocks = bot.inventory.items().find((item) => item.name === "cobblestone")!;
  blocks.count = 64;
  const planned = new CombatPosition(bot, navigation, target, new Set()).planCover();
  assert.equal(planned.kind, "ready");
  if (planned.kind !== "ready") return;
  for (const cell of planned.plan.placements) world.load(cell, { stateId: 1 });
  blocks.count = 0;
  assert.equal(combatResourceRefusal(bot, navigation, target), null);
  assert.equal(
    combatResourceRefusal(bot, { ...navigation, world: new MemoryWorld() }, target),
    null,
    "unknown local geometry is left to the physical cover approach",
  );
});

for (const angry of [false, true]) {
  test(`contact defence distinguishes an ${angry ? "angry" : "unprovoked"} enderman from its neutral-capable species`, async () => {
    const fixture = combatFixture(["iron_sword", "iron_pickaxe", "shield"]);
    const enderman = Object.assign({}, fixture.target, {
      id: 8,
      name: "enderman",
      kind: "Hostile mobs",
      height: 2.9,
      metadata: [],
      position: new Vec3(0.8, 64, 0),
    });
    Reflect.set(
      enderman.metadata,
      fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
      angry,
    );
    fixture.bot.entities[enderman.id] = enderman;
    const attacked: number[] = [];
    const attack = fixture.bot.attack;
    fixture.bot.attack = (entity) => {
      attacked.push(entity.id);
      attack(entity);
    };
    fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
    await createCombatController(fixture.bot, navigationFixture()).engage(
      fixture.target.id,
      new AbortController().signal,
      "hold",
    );
    assert.deepEqual(attacked, [fixture.target.id], "anger does not identify this bot as the victim");
  });
}

test("a refused roof emits its result even when it completes between physics ticks", async () => {
  const fixture = combatFixture(["diamond_sword"]);
  fixture.target.name = "enderman";
  fixture.target.metadata = [];
  fixture.target.position.set(1, 64, 0);
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const controller = createCombatController(fixture.bot, navigationFixture());
  const decisions: CombatDecision[] = [];
  const remove = controller.onDecision((event) => decisions.push(event));
  let removedCalls = 0;
  controller.onDecision(() => removedCalls++)();
  const result = await controller.engage(fixture.target.id, new AbortController().signal, "pursue");
  const repeated = await controller.engage(fixture.target.id, new AbortController().signal, "pursue");
  remove();
  assert.equal(result.kind, "capability_blocked");
  assert.equal(result.attacks, 0, "do not provoke a neutral enderman after protection was refused");
  assert.equal(removedCalls, 0);
  const roof = decisions.find((event) => event.kind === "roof_prepared");
  assert.ok(roof);
  assert.match(roof.stopped ?? "", /COMBAT_BUILD_MATERIALS_MISSING/);
  assert.equal(repeated.kind, "capability_blocked", "a new engagement preserves the settled material refusal");
  assert.equal(repeated.attacks, 0);
  assert.equal(
    decisions.filter((event) => event.kind === "roof_prepared").length,
    1,
    "unchanged failure premises cannot start another roof preparation",
  );
});

for (const clearsFlag of [false, true]) {
  test(`a refused roof preserves defence against an angry enderman (flag clears during preparation: ${clearsFlag})`, async () => {
    const fixture = combatFixture(["diamond_sword", "shield"]);
    fixture.target.name = "enderman";
    fixture.target.position.set(1, 64, 0);
    fixture.target.metadata = [];
    fixture.target.kind = "Hostile mobs";
    const creepy = fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy");
    Reflect.set(fixture.target.metadata, creepy, true);
    if (clearsFlag) fixture.script.onWait = () => Reflect.set(fixture.target.metadata, creepy, false);
    fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
    const result = await controllerAfterObservedHit(fixture.bot, navigationFixture()).engage(
      fixture.target.id,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(result.kind, "died");
    assert.equal(result.attacks, 1);
  });
}

test("an unprotected defensive hold keeps its guard while an angry enderman returns from a teleport", async () => {
  const fixture = combatFixture(["diamond_sword", "shield"], { targetDistance: 8 });
  fixture.target.name = "enderman";
  fixture.target.kind = "Hostile mobs";
  fixture.target.metadata = [];
  Reflect.set(
    fixture.target.metadata,
    fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
    true,
  );
  fixture.script.onWait = () => {
    if (fixture.clock.tick >= 40) fixture.target.position.set(1, 64, 0);
  };
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const outcome = await controllerAfterObservedHit(fixture.bot, navigationFixture()).engage(
    fixture.target.id,
    new AbortController().signal,
    "hold",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
  assert.ok(fixture.clock.tick >= 40);
});

function protectedEndermanFixture(items: readonly string[] = ["diamond_sword", "shield"]) {
  const fixture = combatFixture(items, { targetDistance: 8 });
  fixture.target.name = "enderman";
  fixture.target.height = 2.9;
  fixture.target.kind = "Hostile mobs";
  fixture.target.metadata = [];
  Reflect.set(
    fixture.target.metadata,
    fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
    true,
  );
  fixture.bot.entity.position.set(0.5, 64, 0.5);
  fixture.bot.entity.onGround = true;
  fixture.bot.entity.velocity = new Vec3(0, 0, 0);
  const navigation = navigationFixture();
  const blockAt = fixture.bot.blockAt;
  fixture.bot.blockAt = (cell) =>
    cell.y === 66 && Math.abs(cell.x) <= 1 && Math.abs(cell.z) <= 1
      ? ({ position: cell, shapes: [[0, 0, 0, 1, 1, 1]] } as NonNullable<ReturnType<Bot["blockAt"]>>)
      : blockAt(cell);
  return { ...fixture, navigation };
}

test("an existing roof admits melee provocation when the target's eyes are occluded", async () => {
  const fixture = protectedEndermanFixture();
  fixture.target.metadata = [];
  fixture.target.position.set(2, 64, 0.5);
  fixture.bot.world.raycast = ((_eye, direction) =>
    direction.y > 0.2 ? { position: new Vec3(1, 66, 0) } : null) as Bot["world"]["raycast"];
  assert.equal(combatResourceRefusal(fixture.bot, fixture.navigation, fixture.target), null);
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const controller = createCombatController(fixture.bot, fixture.navigation);
  const decisions: CombatDecision[] = [];
  controller.onDecision((event) => decisions.push(event));
  const result = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
  assert.equal(
    decisions.some((event) => event.kind === "roof_provoked"),
    false,
  );
});

test("an explicitly requested angry Enderman can commit its roof without head-gaze attribution", async () => {
  const fixture = protectedEndermanFixture();
  // The elevated quarry's angry flag is observed, but its quantized head look
  // does not intersect this bot. That cannot authorize an automatic attack.
  using perception = new CombatPerception(fixture.bot);
  assert.equal(perception.attackerIds.has(7), false);
  fixture.script.onWait = () => {
    if (fixture.clock.tick > 20) fixture.target.position.set(2, 64, 0.5);
  };
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const controller = createCombatController(fixture.bot, fixture.navigation, perception);
  const decisions: CombatDecision[] = [];
  controller.onDecision((event) => decisions.push(event));
  const result = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(result.kind, "died");
  assert.equal(result.attacks, 1);
  assert.ok(decisions.some((event) => event.kind === "roof_engagement" && event.state === "waiting"));
  assert.ok(fixture.clock.tick < 100, "an observed angry quarry must not spend the neutral provocation window");
});

test("an explicitly pursued angry Enderman in reach is guarded and hit before searching for landing room", async () => {
  const fixture = protectedEndermanFixture();
  fixture.target.position.set(2, 64, 0.5);
  fixture.bot.blockAt = () => null;
  const world = fixture.navigation.world as MemoryWorld;
  world.load({ x: -1, y: 63, z: 0 }, { stateId: 0 });
  using perception = new CombatPerception(fixture.bot);
  assert.equal(perception.attackerIds.has(7), false, "the quarry's angry flag is not automatic attack attribution");
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  const outcome = await createCombatController(fixture.bot, fixture.navigation, perception).engage(
    7, new AbortController().signal, "pursue",
  );
  assert.equal(outcome.kind, "died", "reachable angry contact must not attempt an unsupported stance search");
  assert.equal(outcome.attacks, 1);
  assert.ok(fixture.itemUse.includes(true), "guard before the exposed contact hit");
});

test("a roof preparation failure stays local when knockback changes the occupied cell", () => {
  const { bot, target, navigation } = protectedEndermanFixture();
  const position = new CombatPosition(bot, navigation, target, new Set());
  position.rejectRoofPreparation(position.cell, "The body left the roof construction cell.");
  assert.ok(position.roofPreparationFailure());
  bot.emit("health");
  assert.ok(position.roofPreparationFailure(), "damage alone cannot renew construction");
  bot.entity.position.x += 1;
  assert.equal(position.roofPreparationFailure(), null, "the new cell was never attempted");
  bot.entity.position.x -= 1;
  assert.ok(position.roofPreparationFailure(), "the old failed site remains answered");
  target.position.x += 1;
  assert.equal(position.roofPreparationFailure(), null, "changed target occupation reopens the geometry");
  position.answered.clear();
});

test("an unprotected enderman defence releases an unproductive teleport wait", async () => {
  const fixture = combatFixture(["diamond_sword", "shield"], { targetDistance: 8 });
  fixture.target.name = "enderman";
  fixture.target.height = 2.9;
  fixture.target.kind = "Hostile mobs";
  fixture.target.metadata = [];
  Reflect.set(
    fixture.target.metadata,
    fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
    true,
  );
  const result = await controllerAfterObservedHit(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(result.kind, "unreachable");
  assert.equal(result.attacks, 0);
  assert.ok(fixture.clock.tick >= 300 && fixture.clock.tick < 330);
  disposeCombatTestResources();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

test("defending contact postpones roof preparation until the enderman teleports away", async () => {
  const fixture = protectedEndermanFixture();
  const roofBlocks = fixture.bot.blockAt;
  const air = roofBlocks(new Vec3(8, 64, 8));
  let swings = 0;
  fixture.target.position.set(2, 64, 0.5);
  fixture.bot.blockAt = (cell) => (cell.y === 66 && swings === 0 ? air : roofBlocks(cell));
  fixture.script.onAttack = () => {
    swings++;
    fixture.bot._client.emit("damage_event", { entityId: 7, sourceCauseId: fixture.bot.entity.id + 1 });
    if (swings === 1) fixture.target.position.set(8, 64, 0.5);
    else fixture.bot.emit("entityDead", fixture.target);
  };
  fixture.script.onWait = () => {
    if (swings === 1 && fixture.clock.tick >= 60) fixture.target.position.set(2, 64, 0.5);
  };
  const outcome = await controllerAfterObservedHit(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(swings, 2);
});

test("a protected enderman that never approaches ends the fight without chasing or resetting on teleports", async () => {
  const fixture = protectedEndermanFixture();
  const decisions: CombatDecision[] = [];
  fixture.script.onWait = () => {
    fixture.target.position.set(fixture.clock.tick % 2 ? 8 : -8, 64, 0);
    fixture.bot.emit("entitySwingArm", fixture.target);
  };
  const controller = controllerAfterObservedHit(fixture.bot, fixture.navigation);
  controller.onDecision((event) => decisions.push(event));
  const outcome = await controller.engage(7, new AbortController().signal, "pursue");
  assert.equal(outcome.kind, "unreachable", JSON.stringify(outcome));
  assert.equal(outcome.attacks, 0);
  assert.ok(fixture.clock.tick >= 300 && fixture.clock.tick < 330);
  assert.ok(decisions.some((event) => event.kind === "roof_engagement" && event.state === "waiting"));
  assert.ok(decisions.some((event) => event.kind === "roof_engagement" && event.state === "stopped"));
  assert.equal(fixture.bot._client.listenerCount("damage_event"), 0);
});

test("contact reached during roof reposition does not inherit the old roof's expired wait", async () => {
  const fixture = protectedEndermanFixture(["diamond_sword", "shield", "cobblestone"]);
  const { bot } = fixture;
  const navigation = { ...fixture.navigation };
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  const world = navigation.world as MemoryWorld;
  for (let x = -10; x <= 10; x++)
    for (let z = -10; z <= 10; z++)
      for (let y = 63; y <= 70; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  let routes = 0;
  navigation.navigate = async (request) => {
    routes++;
    bot.entity.position.set(6.5, 64, 0.5);
    bot.emit("physicsTick");
    assert.equal(request.stopSignal?.aborted, true);
    return { status: "stopped", reason: "attacker reached the new stance" } as Awaited<
      ReturnType<NavigationRuntime["navigate"]>
    >;
  };
  fixture.script.onAttack = () => bot.emit("entityDead", fixture.target);
  const outcome = await controllerAfterObservedHit(bot, navigation).engage(7, new AbortController().signal, "pursue");
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 1);
  assert.equal(routes, 1);
  assert.ok(fixture.clock.tick >= 300);
});

test("only confirmed damage renews a roof engagement while a teleporting target returns", async () => {
  const fixture = protectedEndermanFixture();
  let firstHit = 0;
  fixture.script.onWait = () => {
    if ((!firstHit && fixture.clock.tick >= 120) || (firstHit && fixture.clock.tick - firstHit >= 240))
      fixture.target.position.set(2, 64, 0.5);
  };
  fixture.script.onAttack = () => {
    fixture.bot._client.emit("damage_event", { entityId: 7, sourceCauseId: fixture.bot.entity.id + 1 });
    if (firstHit) fixture.bot.emit("entityDead", fixture.target);
    else {
      firstHit = fixture.clock.tick;
      fixture.target.position.set(8, 64, 0.5);
    }
  };
  const outcome = await controllerAfterObservedHit(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 2);
  assert.ok(fixture.clock.tick > 300);
});

for (const blockedAfter of [0, 40]) {
  test(`a roof lure without another usable position stops when the eye ray is blocked after ${blockedAfter} ticks`, async () => {
    const fixture = protectedEndermanFixture();
    Reflect.set(
      fixture.target.metadata,
      fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
      false,
    );
    fixture.bot.world.raycast = () =>
      fixture.clock.tick >= blockedAfter ? { x: 4, y: 66, z: 0, face: 4, intersect: new Vec3(4, 66, 0) } : null;
    const outcome = await createCombatController(fixture.bot, fixture.navigation).engage(
      7,
      new AbortController().signal,
      "pursue",
    );
    assert.equal(outcome.kind, blockedAfter === 0 ? "capability_blocked" : "unreachable");
    if (outcome.kind !== "unreachable" && outcome.kind !== "capability_blocked")
      throw new Error("Expected an obstructed lure.");
    assert.match(
      outcome.observation,
      blockedAfter === 0 ? /COMBAT_BUILD_MATERIALS_MISSING/ : /Enderman lure obstructed/,
    );
    assert.equal(outcome.attacks, 0);
    assert.ok(fixture.clock.tick >= blockedAfter && fixture.clock.tick < blockedAfter + 20);
    disposeCombatTestResources();
    assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
    assert.equal(fixture.bot._client.listenerCount("damage_event"), 0);
  });
}

test("an angry enderman behind a wall keeps its protected return wait", async () => {
  const fixture = protectedEndermanFixture();
  fixture.target.kind = "Hostile mobs";
  Reflect.set(
    fixture.target.metadata,
    fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
    true,
  );
  fixture.bot.world.raycast = () => ({ x: 4, y: 66, z: 0, face: 4, intersect: new Vec3(4, 66, 0) });
  const outcome = await controllerAfterObservedHit(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "unreachable");
  if (outcome.kind !== "unreachable") throw new Error("Expected the protected wait to expire.");
  assert.match(outcome.observation, /No confirmed damage/);
  assert.ok(fixture.clock.tick >= 300 && fixture.clock.tick < 330);
});

test("unconfirmed swings and other attackers' damage cannot keep a protected fight alive", async () => {
  const fixture = protectedEndermanFixture();
  fixture.target.position.set(2, 64, 0.5);
  fixture.script.onAttack = () => {
    fixture.bot._client.emit("damage_event", { entityId: 7, sourceCauseId: 99 });
  };
  const outcome = await controllerAfterObservedHit(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "unreachable");
  assert.ok(outcome.attacks > 0);
  assert.ok(fixture.clock.tick >= 300 && fixture.clock.tick < 340);
});

test("a protected enderman leaving observation releases the hunt to select another target", async () => {
  const fixture = protectedEndermanFixture();
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 40) fixture.bot.emit("entityGone", fixture.target);
  };
  const outcome = await createCombatController(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "target_lost");
  assert.equal(outcome.attacks, 0);
  assert.ok(fixture.clock.tick < 50);
});

test("cancelling a roof lure releases its listeners promptly", async () => {
  const fixture = protectedEndermanFixture();
  const stop = new AbortController();
  fixture.script.onWait = () => {
    if (fixture.clock.tick === 40) stop.abort("operator cancelled");
  };
  const outcome = await createCombatController(fixture.bot, fixture.navigation).engage(7, stop.signal, "pursue");
  assert.equal(outcome.kind, "cancelled");
  assert.ok(fixture.clock.tick < 50);
  assert.equal(fixture.bot._client.listenerCount("damage_event"), 0);
  disposeCombatTestResources();
  assert.equal(fixture.bot.listenerCount("physicsTick"), 0);
});

for (const name of ["fire", "soul_fire", "stone"]) {
  test(`cover passage maintenance only punches fire without taking movement or item controls (${name})`, async () => {
    const fixture = combatFixture(["iron_sword", "shield"]);
    const cell = new Vec3(1, 64, 0);
    let remaining = true;
    const punches: string[] = [];
    fixture.bot.blockAt = (at) =>
      remaining && at.equals(cell) ? ({ name, position: cell } as NonNullable<ReturnType<Bot["blockAt"]>>) : null;
    fixture.bot.canDigBlock = () => true;
    fixture.bot.dig = async (block) => {
      punches.push(block.name);
      remaining = false;
    };
    const cover = new CombatPosition(fixture.bot, navigationFixture(), fixture.target, new Set());
    assert.equal(await cover.extinguishFireAt(cell, new AbortController().signal), "clear");
    assert.deepEqual(punches, name === "stone" ? [] : [name]);
    assert.deepEqual(fixture.controls, []);
    assert.deepEqual(fixture.equipped, []);
    assert.deepEqual(fixture.itemUse, []);
  });
}

test("cancelling while aiming at passage fire never starts the punch afterwards", async () => {
  const fixture = combatFixture([]);
  const cell = new Vec3(1, 64, 0);
  const abort = new AbortController();
  fixture.bot.blockAt = (at) =>
    at.equals(cell) ? ({ name: "fire", position: cell } as NonNullable<ReturnType<Bot["blockAt"]>>) : null;
  fixture.bot.canDigBlock = () => true;
  fixture.bot.lookAt = async () => abort.abort();
  fixture.bot.dig = async () => assert.fail("cancelled punch started");
  const cover = new CombatPosition(fixture.bot, navigationFixture(), fixture.target, new Set());
  await assert.rejects(cover.extinguishFireAt(cell, abort.signal));
});

test("an unproductive refuge is rejected instead of terminating the engagement", async () => {
  const { bot, target, script, clock } = combatFixture(["iron_sword", "cobblestone"]);
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  bot.entity.position.set(0.5, 64, 0.5);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.entity.onGround = true;
  bot.entity.velocity = new Vec3(0, 0, 0);
  bot.health = 20;
  bot.food = 20;
  target.name = "blaze";
  target.position.set(0.5, 64, -8);
  target.metadata = [];
  const navigation = navigationFixture();
  const world = new MemoryWorld();
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++)
      for (let y = 63; y <= 72; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  const threat = positionThreat(bot, target);
  const plan = findCombatPosition(world, bot.entity.position.floored(), [threat], threat, 64)!;
  assert.ok(plan);
  for (const cell of plan.placements) world.load(cell, { stateId: 1 });
  Object.defineProperty(bot, "world", { value: positionWorld(world) });
  const cancelled = new AbortController();
  // The production protected-wait budget is 300 ticks. Allow the release
  // handoff, but reject both a reset and the former ninety-second wait.
  script.onWait = () => {
    if (clock.tick > 400) cancelled.abort();
  };
  const controller = createCombatController(bot, {
    ...navigation,
    world,
    navigate: async (options) => {
      const goal = options.goal.resolve(observation());
      assert.equal(goal.kind, "active");
      if (goal.kind !== "active") throw new Error("invalid test goal");
      const destination = [plan.protected, plan.corner, plan.fighting].find((feet) =>
        goal.isSatisfied({ feet, remainingScaffolds: 0, overlayId: "0" }, goalTestWorld),
      );
      assert.ok(destination, "a blind refuge must not be discarded into an open pursuit");
      bot.entity.position = destination.offset(0.5, 0, 0.5);
      return { status: "completed", elapsedMs: 1 };
    },
  });
  let rejected = false;
  controller.onDecision((event) => {
    if (event.kind === "position_rejected") {
      rejected = true;
      cancelled.abort("Position rejection observed; end this fixture before the next plan.");
    }
  });
  const result = await controller.engage(target.id, cancelled.signal, "pursue");
  assert.equal(result.kind, "cancelled", JSON.stringify(result));
  assert.equal(rejected, true);
  assert.equal(bot.inventory.items().find((item) => item.name === "cobblestone")!.count, 64);
});

for (const interruption of [
  "volley",
  "hurt",
  "cancel",
  "close target",
  "death during recovery",
  "held charge",
  "charge requires sight",
  "closing shooter",
  "cover knockback",
  "establish knockback",
  "known charge without shield",
] as const) {
  test(`existing cover attacks, returns and holds within one engagement on ${interruption}`, async () => {
    const fixture = combatFixture(
      interruption === "establish knockback"
        ? ["bow", "arrow", "cobblestone"]
        : interruption === "closing shooter"
          ? ["iron_sword", "bow", "arrow", "shield"]
          : interruption === "charge requires sight"
            ? ["bow", "arrow", "shield"]
            : ["bow", "arrow"],
    );
    const { bot, target, script } = fixture;
    bot.entity.position.set(0.5, 64, 0.5);
    bot.entity.width = 0.6;
    bot.entity.height = 1.8;
    bot.entity.onGround = true;
    bot.entity.velocity = new Vec3(0, 0, 0);
    bot.health = 20;
    bot.food = 20;
    target.name = "blaze";
    target.kind = "Hostile mobs";
    target.position.set(0.5, 64, interruption === "close target" ? -4.5 : -8);
    target.metadata = [];
    const world = new MemoryWorld();
    for (let x = -12; x <= 12; x++)
      for (let z = -12; z <= 12; z++)
        for (let y = 63; y <= 72; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
    const threat = positionThreat(bot, target);
    const plan = findCombatPosition(world, bot.entity.position.floored(), [threat], threat, 64)!;
    assert.ok(plan);
    if (interruption !== "establish knockback") for (const cell of plan.placements) world.load(cell, { stateId: 1 });
    Object.defineProperty(bot, "world", { value: positionWorld(world) });
    const destinations: Vec3[] = [];
    let protectedArrivals = 0;
    const knocksDuringPosition = interruption === "cover knockback" || interruption === "establish knockback";
    let pendingImpulse = false;
    let navigationReleased = false;
    let landingRecovered = false;
    using recovery = new FootingRecovery(bot, world);
    if (knocksDuringPosition) {
      Object.defineProperty(recovery, "needed", { get: () => pendingImpulse });
      recovery.recover = async () => {
        assert.equal(navigationReleased, true, "release the route before giving landing recovery the controls");
        landingRecovered = true;
        pendingImpulse = false;
        bot.entity.onGround = true;
        bot.emit("entityDead", target);
        return "landed";
      };
    }
    const navigation: NavigationRuntime = {
      ...navigationFixture(),
      world,
      releaseForTakeover: () => {
        navigationReleased = true;
      },
      navigate: async (options) => {
        if (knocksDuringPosition && !landingRecovered) {
          pendingImpulse = true;
          bot.entity.onGround = false;
          bot.emit("physicsTick");
          assert.equal(options.signal?.aborted, true, "cover execution must yield to the observed unsafe impulse");
          throw options.signal!.reason;
        }
        const goal = options.goal.resolve(observation());
        assert.equal(goal.kind, "active");
        if (goal.kind !== "active") throw new Error("invalid test goal");
        const destination = [plan.protected, plan.corner, plan.fighting].find((feet) =>
          goal.isSatisfied({ feet, remainingScaffolds: 0, overlayId: "0" }, goalTestWorld),
        );
        assert.ok(destination, "cover must never pursue beyond its three supported cells");
        bot.entity.position = destination.offset(0.5, 0, 0.5);
        if (interruption === "closing shooter" && destination.equals(plan.fighting)) {
          // A native route ends slightly off the plan's exact centre. The
          // approaching shooter is now a reachable sword target from here.
          bot.entity.position.x += 0.03;
          target.position = bot.entity.position.offset(0, 0, -1.5);
        }
        destinations.push(destination);
        if (destination.equals(plan.protected)) protectedArrivals++;
        if (interruption === "charge requires sight" && protectedArrivals >= 20)
          signal.abort("Repeated peeks never let the visible charge advance");
        bot.emit("physicsTick");
        if (destination.equals(plan.protected) && interruption !== "hurt" && interruption !== "death during recovery")
          script.onWait?.(1);
        return { status: "completed", elapsedMs: 1 };
      },
    };
    const controller = createCombatController(bot, navigation, undefined, recovery);
    const signal = new AbortController();
    const flag = bot.registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
    if (interruption === "known charge without shield") Reflect.set(target.metadata, flag, 0);
    let interrupted = false;
    let returned = false;
    let visibleChargeTicks = 0;
    const blaze = new ScriptedBlaze();
    script.onWait = () => {
      const atFight = bot.entity.position.distanceTo(plan.fighting.offset(0.5, 0, 0.5)) < 0.1;
      if (interruption === "closing shooter" || knocksDuringPosition) return;
      if (interruption === "charge requires sight" || interruption === "known charge without shield") {
        // A hidden shooter's charged flag does not clear just because we wait
        // in the refuge. The firing position must hold the visible windup.
        blaze.tick(atFight);
        Reflect.set(target.metadata, flag, blaze.charging ? 1 : 0);
        if (atFight) visibleChargeTicks++;
        return;
      }
      if (!interrupted && atFight) {
        interrupted = true;
        if (interruption === "hurt" || interruption === "death during recovery") bot.health = 11;
        else Reflect.set(target.metadata, flag, 1);
      } else if (interrupted && bot.entity.position.distanceTo(plan.protected.offset(0.5, 0, 0.5)) < 0.1) {
        returned = true;
        assert.equal(controller.canRecover(), true);
        if (interruption === "cancel") signal.abort();
        else if (interruption === "death during recovery") bot.emit("entityDead", target);
        else if (interruption === "held charge" && protectedArrivals < 2) return;
        else {
          bot.health = 20;
          Reflect.set(target.metadata, flag, 0);
        }
      }
    };
    script.onShot = () => {
      assert.notEqual(interruption, "closing shooter", "actual melee contact must select the shielded sword");
      if (interruption === "known charge without shield") {
        assert.equal(blaze.charging, true);
        assert.equal(blaze.shots, 0, "finish one shot during the observed first charge instead of abandoning it");
      }
      bot.emit("entityDead", target);
    };
    if (interruption === "closing shooter") script.onAttack = () => bot.emit("entityDead", target);
    const result = await controller.engage(target.id, signal.signal, "pursue");
    assert.equal(result.kind, interruption === "cancel" ? "cancelled" : "died", JSON.stringify(result));
    if (interruption === "charge requires sight") {
      assert.ok(visibleChargeTicks >= 60, "hold the shield through the visible windup before shooting");
      assert.ok(protectedArrivals < 20);
    } else if (interruption === "closing shooter") {
      assert.deepEqual(result.stylesUsed, ["shielded_melee"]);
      assert.equal(result.attacks, 1);
    } else if (interruption === "known charge without shield") {
      assert.equal(result.attacks, 1);
    } else if (knocksDuringPosition) {
      assert.equal(landingRecovered, true);
      assert.equal(result.attacks, 0);
    } else assert.equal(returned, true);
    if (interruption === "held charge")
      assert.ok(protectedArrivals >= 2, "peek again to advance a charge held behind cover");
    if (
      interruption !== "charge requires sight" &&
      interruption !== "closing shooter" &&
      interruption !== "known charge without shield" &&
      !knocksDuringPosition
    )
      assert.ok(destinations.some((cell) => cell.equals(plan.protected)));
    assert.equal(controller.canRecover(), false, "the released engagement no longer promises a return");
    recovery[Symbol.dispose]();
    disposeCombatTestResources();
    assert.equal(bot.listenerCount("physicsTick"), 0);
  });
}

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
  fixture.bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
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
  await fixture.bot.equip(
    fixture.bot.inventory.items().find((item) => item.name === "shield")!,
    "off-hand",
  );
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
    await fixture.bot.equip(
      fixture.bot.inventory.items().find((item) => item.name === "shield")!,
      "off-hand",
    );
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

function navigationFixture(): NavigationRuntime {
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++) {
      world.load({ x, y: 63, z }, { stateId: 1 });
      world.load({ x, y: 64, z }, { stateId: 0 });
      world.load({ x, y: 65, z }, { stateId: 0 });
    }
  return {
    world,
    active: false,
    cancel: () => undefined,
    onEvent: () => () => undefined,
    navigate: async () => {
      throw new Error("This combat fixture did not expect navigation.");
    },
  } as unknown as NavigationRuntime;
}

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
      await fixture.bot.equip(
        fixture.bot.inventory.items().find((item) => item.name === "iron_pickaxe")!,
        "hand",
      );
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

/** A bow target: holds a bow, and `drawing` drives the server's hand-state flag. */
function armWithBow(target: Entity): { drawing: (active: boolean) => void } {
  const metadata: unknown[] = [];
  metadata[8] = 0;
  target.metadata = metadata as Entity["metadata"];
  Object.defineProperty(target, "heldItem", { value: { name: "bow", type: 1 } });
  return { drawing: (active) => (metadata[8] = active ? 0x01 : 0) };
}

function combatFixture(
  items: readonly string[],
  options: { readonly startingHeld?: string; readonly targetDistance?: number } = {},
): {
  readonly script: CombatScript;
  readonly clock: { tick: number };
  readonly attackTicks: number[];
  readonly shotTicks: number[];
  readonly bot: Bot;
  readonly target: Entity;
  readonly equipped: string[];
  readonly unequipped: string[];
  readonly itemUse: boolean[];
  readonly timeline: string[];
  /** Every movement control the controller touched; combat is expected to touch none. */
  readonly controls: string[];
  readonly activeControls: Set<string>;
  readonly directAttacks: { count: number };
  readonly controlsCleared: { count: number };
} {
  const script: CombatScript = {};
  const clock = { tick: 0 };
  const attackTicks: number[] = [];
  const shotTicks: number[] = [];
  let using: "idle" | "bow" | "shield" = "idle";
  const events = new EventEmitter();
  const target = {
    id: 7,
    name: "zombie",
    isValid: true,
    height: 1.95,
    width: 0.6,
    position: new Vec3(options.targetDistance ?? 2, 64, 0),
  } as Entity;
  const inventory = items.map((name, type) => ({ name, type }));
  const slots: unknown[] = new Array(46).fill(null);
  const equipped: string[] = [];
  const unequipped: string[] = [];
  const itemUse: boolean[] = [];
  const timeline: string[] = [];
  const controls: string[] = [];
  const activeControls = new Set<string>();
  const directAttacks = { count: 0 };
  const controlsCleared = { count: 0 };
  let heldItem: { name: string; type: number } | null = options.startingHeld
    ? { name: options.startingHeld, type: -1 }
    : null;

  const bot = Object.assign(events, {
    _client: new EventEmitter(),
    game: { dimension: "overworld" },
    entities: { [target.id]: target },
    entity: { id: 2, yaw: 0, position: new Vec3(0, 64, 0) },
    world: { raycast: () => null },
    blockAt: () => null,
    // Only the approach's movement policy reads this; it is what an unreachable target costs to test.
    registry: minecraftData("1.21.4"),
    heldItem: null,
    inventory: Object.assign(new EventEmitter(), { items: () => inventory, slots }),
    equip: async (item: { name: string; type: number }, destination: string) => {
      equipped.push(`${item.name}:${destination}`);
      if (destination === "hand") heldItem = item;
      if (destination === "off-hand") slots[45] = item;
    },
    unequip: async (destination: string) => {
      unequipped.push(destination);
      if (destination === "hand") heldItem = null;
    },
    quickBarSlot: 0,
    usingHeldItem: false,
    setQuickBarSlot: (slot: number) => {
      timeline.push(`slot:${slot}`);
      (bot as { quickBarSlot: number }).quickBarSlot = slot;
      using = "idle";
      bot.usingHeldItem = false;
    },
    activateItem: (offHand = false) => {
      itemUse.push(offHand);
      timeline.push(offHand ? "shield-up" : "item-use");
      using = offHand ? "shield" : "bow";
      bot.usingHeldItem = true;
    },
    deactivateItem: () => {
      itemUse.push(false);
      timeline.push("item-down");
      const shot = using === "bow";
      using = "idle";
      bot.usingHeldItem = false;
      if (shot) {
        shotTicks.push(clock.tick);
        script.onShot?.();
      }
    },
    clearControlStates: () => {
      controlsCleared.count += 1;
      activeControls.clear();
    },
    setControlState: (control: string, active: boolean) => {
      controls.push(control);
      if (active) activeControls.add(control);
      else activeControls.delete(control);
    },
    waitForTicks: (ticks: number) => waitForPhysicsTicks(events, ticks, new AbortController().signal),
    lookAt: async (point: Vec3) => {
      timeline.push("look");
      bot.entity.yaw = Math.atan2(bot.entity.position.x - point.x, bot.entity.position.z - point.z);
    },
    attack: () => {
      directAttacks.count += 1;
      timeline.push("attack");
      attackTicks.push(clock.tick);
      script.onAttack?.();
    },
  }) as unknown as Bot;
  Object.defineProperty(bot, "heldItem", { get: () => heldItem });
  // Physics is independent of the controller's wait API, as it is on a server.
  // A new listener starts the fixture clock; the test owns its final cleanup.
  let scheduled: ReturnType<typeof setImmediate> | null = null;
  let stopped = false;
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (stopped || events.listenerCount("physicsTick") === 0) return;
      clock.tick++;
      script.onWait?.(1);
      events.emit("physicsTick");
      schedule();
    });
  };
  events.on("newListener", (event) => {
    if (event === "physicsTick") schedule();
  });
  fixtureClocks.add(() => {
    stopped = true;
    if (scheduled) clearImmediate(scheduled);
  });
  return {
    script,
    clock,
    attackTicks,
    shotTicks,
    bot,
    target,
    equipped,
    unequipped,
    itemUse,
    timeline,
    controls,
    activeControls,
    directAttacks,
    controlsCleared,
  };
}

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

test("a roof approach yields its facing when another attacker enters reach", async () => {
  const fixture = blazePreflightFixture(["iron_sword", "shield", "cobblestone"]);
  const { bot, target, navigation, world } = fixture;
  target.name = "enderman";
  target.height = 2.9;
  target.metadata = [];
  bot.inventory.items().find((item) => item.name === "cobblestone")!.count = 64;
  // No usable local roof on this layer; navigation must seek another platform.
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 0 });
  const attacker = Object.assign({}, target, { id: 8, name: "zombie", height: 1.8, position: new Vec3(-1, 64, 0) });
  let approaches = 0;
  navigation.navigate = async (request) => {
    approaches++;
    assert.equal(request.movements.allowDigging, true, "a neutral quarry permits the hunt's ordinary excavation");
    assert.equal(request.movements.allowPlacing, true, "an upper roof can require the carried scaffold blocks");
    bot.entities[attacker.id] = attacker;
    bot.emit("physicsTick");
    assert.equal(request.stopSignal?.aborted, true, "navigation must release facing before its next step");
    return { status: "stopped", reason: "contact" } as Awaited<ReturnType<NavigationRuntime["navigate"]>>;
  };
  const attacked: number[] = [];
  bot.attack = (entity) => {
    attacked.push(entity.id);
    bot.emit("entityDead", entity);
    bot.emit("entityGone", target);
  };
  const result = await createCombatController(bot, navigation).engage(
    target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "target_lost");
  assert.equal(approaches, 1);
  assert.deepEqual(attacked, [attacker.id]);
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

test("a retreat releases sprint even when enabling forward movement fails", async () => {
  const fixture = combatFixture(["iron_sword"]);
  const writes: string[] = [];
  fixture.bot.setControlState = (control, state) => {
    writes.push(`${control}:${state}`);
    if (control === "forward" && state) throw new Error("forward rejected");
  };

  await assert.rejects(
    retreatFromCreepers(fixture.bot, new AbortController().signal, () => false),
    /forward rejected/,
  );

  assert.deepEqual(writes, ["sprint:true", "forward:true", "forward:false", "sprint:false"]);
});

test("ends bow combat when a windup outlasts its guard limit", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], {
    targetDistance: 10,
  });
  armWithBow(fixture.target).drawing(true);
  Object.assign(fixture.target, { kind: "Hostile mobs", headYaw: Math.PI / 2, pitch: 0 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  const cancellation = new AbortController();
  let ticks = 0;
  fixture.script.onWait = (count) => {
    ticks += count;
    // A broken guard must not hang the test: this is beyond two existing guard windows.
    if (ticks >= 250) cancellation.abort("guard did not settle");
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

test("uses melee inside bow range even when carrying a bow and arrows", async () => {
  const fixture = combatFixture(["bow", "arrow", "iron_sword", "shield"], { targetDistance: 2 });

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.deepEqual(outcome.stylesUsed, ["shielded_melee"]);
  assert.deepEqual(outcome.weaponsUsed, ["iron_sword"]);
  assert.deepEqual(fixture.equipped, ["shield:off-hand", "iron_sword:hand"]);
  assert.equal(fixture.directAttacks.count, 1);
});

test("raises the shield when a bow target starts drawing, then resumes its own shot", async () => {
  const fixture = combatFixture(["bow", "arrow", "shield"], { targetDistance: 10 });
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  Object.assign(fixture.target, { kind: "Hostile mobs", headYaw: Math.PI / 2, pitch: 0 });
  Object.assign(fixture.bot.entity, { width: 0.6, height: 1.8 });
  let waitedTicks = 0;
  fixture.script.onWait = (ticks) => {
    waitedTicks += ticks;
    if (waitedTicks >= 3) skeleton.drawing(false);
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
  let waitedTicks = 0;
  fixture.script.onWait = (ticks) => {
    waitedTicks += ticks;
    if (waitedTicks >= 20) fixture.bot.emit("entityGone", fixture.target);
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
  assert.ok(waitedTicks < 20, "waiting for the volley lets the skeleton leave before the swing");
});

test("rechecks for a bow draw after the melee shield readiness wait", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  let waitedTicks = 0;
  fixture.script.onWait = (ticks) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      waitedTicks += 1;
      if (waitedTicks === 2) skeleton.drawing(true);
      if (waitedTicks === 8) skeleton.drawing(false);
    }
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
  assert.ok(waitedTicks > 5);
});

test("resumes a shielded approach when a drawing target backs out of melee reach", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const skeleton = armWithBow(fixture.target);
  skeleton.drawing(true);
  let waitedTicks = 0;
  fixture.script.onWait = (ticks) => {
    waitedTicks += ticks;
    if (waitedTicks === 6) fixture.target.position.x = 4;
    if (waitedTicks >= 20) skeleton.drawing(false);
  };
  const navigation = {
    ...navigationFixture(),
    navigate: async () => {
      assert.ok(waitedTicks < 20, "follow the retreat while the shield covers the draw");
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
  fixture.script.onWait = (ticks) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      if (fixture.directAttacks.count !== 1) continue;
      ticksAfterFirstAttack += 1;
      if (ticksAfterFirstAttack === 1) skeleton.drawing(true);
      if (ticksAfterFirstAttack === 16) skeleton.drawing(false);
    }
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

for (const offset of [new Vec3(8, 0, 0), new Vec3(2, 5, 0)]) {
  test(`an enderman without reachable protection is neither chased nor shot at ${offset}`, async () => {
    const fixture = combatFixture(["iron_sword", "shield", "bow", "arrow"]);
    fixture.target.name = "enderman";
    fixture.target.kind = "Hostile mobs";
    fixture.target.metadata = [];
    Reflect.set(
      fixture.target.metadata,
      fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"),
      true,
    );
    fixture.target.position = fixture.bot.entity.position.plus(offset);
    fixture.bot.blockAt = (() => null) as Bot["blockAt"];
    fixture.script.onShot = () => assert.fail("Enderman combat must not fire an arrow.");
    fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
    let approaches = 0;
    const navigation = {
      ...navigationFixture(),
      navigate: async () => {
        approaches += 1;
        fixture.target.position = fixture.bot.entity.position.offset(2, 0, 0);
        return { status: "completed", elapsedMs: 1 } as const;
      },
    };

    const outcome = await controllerAfterObservedHit(fixture.bot, navigation).engage(
      7,
      new AbortController().signal,
      "pursue",
    );

    assert.equal(outcome.kind, "unreachable");
    assert.equal(approaches, 0);
    assert.equal(outcome.attacks, 0);
    assert.deepEqual(outcome.stylesUsed, ["shielded_melee"]);
    assert.deepEqual(fixture.shotTicks, []);
  });
}

test("reports an enderman death observed while waiting for a teleport return", async () => {
  const fixture = protectedEndermanFixture();
  fixture.script.onWait = () => {
    if (fixture.clock.tick > 40) fixture.bot.emit("entityDead", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, fixture.navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 0);
});

test("hits a creeper sprinting and sprints clear of its fuse instead of waiting a cooldown beside it", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  fixture.target.name = "creeper";
  const stone = { name: "stone", boundingBox: "block" };
  const air = { name: "air", boundingBox: "empty" };
  fixture.bot.blockAt = ((position: Vec3) => (position.y < 64 ? stone : air)) as Bot["blockAt"];
  fixture.script.onAttack = () => {
    // Knocked clear, and dead on the second swing.
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
    if (fixture.directAttacks.count === 2) fixture.bot.emit("entityDead", fixture.target);
  };
  fixture.script.onWait = () => {
    // Sprinting away from the creeper: one block a tick in this fixture.
    if (fixture.activeControls.has("forward")) {
      fixture.bot.entity.position = fixture.bot.entity.position.offset(-1, 0, 0);
    }
  };
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
      fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 2);
  assert.equal(outcome.explosions, 0);
  assert.deepEqual(outcome.stylesUsed, ["shielded_melee"], "the shield protects readiness before the knockback hit");
  assert.ok(fixture.controls.includes("sprint") && fixture.controls.includes("forward"));
  assert.equal(fixture.controls.includes("back"), false);
  assert.equal(fixture.itemUse.includes(true), true, "the shared guard remains available against a creeper");
});

/** A creeper fixture whose retreat headings are recorded, on flat ground unless `wall` says otherwise. */
function creeperFixture(options: { readonly wall?: (position: Vec3) => boolean } = {}) {
  const fixture = combatFixture(["iron_sword"]);
  fixture.target.name = "creeper";
  const stone = { name: "stone", boundingBox: "block" };
  const air = { name: "air", boundingBox: "empty" };
  fixture.bot.blockAt = ((position: Vec3) =>
    position.y < 64 || options.wall?.(position) ? stone : air) as Bot["blockAt"];
  const headings: Vec3[] = [];
  fixture.bot.lookAt = async (point: Vec3) => {
    headings.push(point.minus(fixture.bot.entity.position));
  };
  return { ...fixture, headings };
}

test("a nearby melee crowd cannot turn a creeper retreat toward the fuse", async () => {
  const fixture = creeperFixture();
  fixture.target.position = new Vec3(2, 64, 0);
  const husk = {
    id: 8,
    name: "husk",
    kind: "Hostile mobs",
    isValid: true,
    position: new Vec3(-1, 64, 0),
    height: 1.95,
  } as Entity;
  fixture.bot.entities[husk.id] = husk;
  await retreatFromCreepers(fixture.bot, new AbortController().signal, () => fixture.headings.length > 0);
  assert.ok(fixture.headings.length > 0);
  const awayFromFuse = fixture.bot.entity.position.minus(fixture.target.position);
  const heading = fixture.headings[0]!;
  assert.ok(
    heading.x * awayFromFuse.x + heading.z * awayFromFuse.z >= -1e-9,
    `A retreat step must not deliberately close on the creeper: ${heading}.`,
  );
});

test("a creeper in measured body reach is struck without an unnecessary approach", async () => {
  const fixture = creeperFixture();
  fixture.target.position.x = 3.2;
  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);
  let approaches = 0;
  const navigation: NavigationRuntime = {
    ...navigationFixture(),
    navigate: async (request) => {
      approaches++;
      assert.equal(request.stopSignal?.aborted, false);
      fixture.target.position.x = 2;
      return { status: "completed", elapsedMs: 0 };
    },
  };
  const result = await createCombatController(fixture.bot, navigation).engage(
    fixture.target.id,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(result.kind, "died");
  assert.equal(approaches, 0);
});

test("a blocked multi-creeper escape counters both fuses under the original request", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow"]);
  fixture.target.name = "creeper";
  const stone = { name: "stone", boundingBox: "block" };
  fixture.bot.blockAt = ((_position: Vec3) => stone) as Bot["blockAt"];
  fixture.bot.entities[8] = {
    id: 8,
    name: "creeper",
    isValid: true,
    height: 1.7,
    width: 0.6,
    position: new Vec3(0, 64, 2),
  } as Entity;
  const swellIndex = fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  for (const entity of [fixture.target, fixture.bot.entities[8]!]) {
    entity.metadata = [];
    Reflect.set(entity.metadata, swellIndex, 1);
  }
  const hits: number[] = [];
  fixture.bot.attack = entity => {
    hits.push(entity.id);
    entity.isValid = false;
    fixture.bot.emit("entityDead", entity);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.targetId, 7);
  assert.deepEqual(hits.sort(), [7, 8]);
});

test("an incidental creeper releases the melee shield before sprinting clear", async () => {
  const fixture = combatFixture(["iron_sword", "shield"]);
  const { bot } = fixture;
  bot.entity.onGround = true;
  bot.entity.velocity = new Vec3(0, 0, 0);
  bot.entity.position.set(0.5, 64, 0.5);
  bot.health = 20;
  bot.blockAt = ((position: Vec3) => ({
    name: position.y < 64 ? "stone" : "air",
    boundingBox: position.y < 64 ? "block" : "empty",
  })) as Bot["blockAt"];
  const controls = new Map<string, boolean>();
  bot.setControlState = (control, value) => {
    controls.set(control, value);
  };
  const metadata: unknown[] = [];
  const swell = bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  metadata[swell] = -1;
  bot.entities[8] = {
    id: 8,
    name: "creeper",
    isValid: true,
    metadata,
    height: 1.7,
    position: new Vec3(3, 64, 0.5),
  } as Entity;
  fixture.script.onAttack = () => {
    metadata[swell] = 1;
  };
  let sprinted = false;
  fixture.script.onWait = () => {
    assert.ok(fixture.clock.tick < 100, "the nearby fuse must provoke a retreat and complete clearance");
    if (!controls.get("sprint") || !controls.get("forward")) return;
    assert.equal(bot.usingHeldItem, false, "blocking slows the supposed escape sprint");
    assert.equal(controls.get("sneak"), false, "the hold must release crouch before retreating");
    sprinted = true;
    bot.entity.position.x -= 1;
    bot.emit("entityDead", fixture.target);
  };
  const outcome = await createCombatController(bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "hold",
  );
  assert.equal(outcome.kind, "died", JSON.stringify(outcome));
  assert.equal(sprinted, true);
});

test("blocked incidental fuses are answered before returning to the original quarry", async () => {
  const fixture = combatFixture(["iron_sword"]);
  const stone = { name: "stone", boundingBox: "block" };
  fixture.bot.blockAt = ((_position: Vec3) => stone) as Bot["blockAt"];
  const metadata: unknown[] = [];
  metadata[fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir")] = 1;
  fixture.bot.entities[8] = {
    id: 8,
    name: "creeper",
    isValid: true,
    metadata,
    height: 1.7,
    width: 0.6,
    position: new Vec3(0, 64, 2),
  } as Entity;
  fixture.bot.entities[9] = { ...fixture.bot.entities[8]!, id: 9, position: new Vec3(0, 64, -2) } as Entity;
  const hits: number[] = [];
  fixture.bot.attack = entity => {
    hits.push(entity.id);
    entity.isValid = false;
    fixture.bot.emit("entityDead", entity);
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.targetId, 7);
  assert.deepEqual(hits.slice(0, 2).sort(), [8, 9]);
  assert.equal(hits.at(-1), 7);
});

test("an incidental creeper counter does not complete the requested quarry", async () => {
  const fixture = combatFixture(["iron_sword"]);
  fixture.bot.blockAt = (() => ({ name: "stone", boundingBox: "block" })) as unknown as Bot["blockAt"];
  const metadata: unknown[] = [];
  metadata[fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir")] = 1;
  const creeper = { ...fixture.target, id: 8, name: "creeper", metadata, position: new Vec3(0, 64, 2) } as Entity;
  fixture.bot.entities[8] = creeper;
  const hit: number[] = [];
  fixture.bot.attack = (entity) => {
    hit.push(entity.id);
    fixture.bot.emit("entityDead", entity);
    entity.isValid = false;
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(7, new AbortController().signal, "pursue");
  assert.deepEqual(hit, [8, 7]);
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.targetId, 7);
});

test("a sprint clear of one creeper runs from every creeper within fuse range, nearest weighted most", async () => {
  const fixture = creeperFixture();
  // The target is two blocks east; a second creeper stands ten blocks south:
  // beyond the range that forbids the swing, inside the range a sprint clear
  // still steers away from.
  const second = { id: 8, name: "creeper", isValid: true, height: 1.7, position: new Vec3(0, 64, 10) } as Entity;
  fixture.bot.entities[second.id] = second;
  fixture.script.onAttack = () => {
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
  };
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      // Sprinting along the last heading asked for, one block a tick.
      const heading = fixture.headings.at(-1);
      if (heading) {
        const flat = new Vec3(heading.x, 0, heading.z).normalize();
        fixture.bot.entity.position = fixture.bot.entity.position.plus(flat);
      }
    }
    // Clear of both fuses: the creepers lose interest and the fight settles.
    if (
      fixture.bot.entity.position.distanceTo(fixture.target.position) >= 8 &&
      fixture.bot.entity.position.distanceTo(second.position) >= 12
    )
      fixture.bot.emit("entityGone", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  assert.equal(outcome.attacks, 1);
  const retreat = fixture.headings.filter((heading) => heading.x < 0 || heading.z < 0);
  assert.ok(retreat.length > 0, "the bot sprinted somewhere");
  assert.ok(
    retreat.every((heading) => heading.x < 0 && heading.z < 0),
    `every retreat heading points away from both creepers: ${retreat.map((h) => `${h.x.toFixed(1)},${h.z.toFixed(1)}`).join(" ")}`,
  );
});

test("covered creepers do not suppress a reachable spider while pursuing gunpowder", async () => {
  const fixture = creeperFixture();
  fixture.bot.time = { timeOfDay: 18000 } as Bot["time"];
  fixture.target.position.set(2.5, 64, 0);
  const second = { ...fixture.target, id: 8, position: new Vec3(4, 64, 1) } as Entity;
  const spider = { ...fixture.target, id: 9, name: "spider", kind: "Hostile mobs", width: 1.4, height: 0.9,
    position: new Vec3(0, 64, 3.5) } as Entity;
  fixture.bot.entities[8] = second;
  fixture.bot.entities[9] = spider;
  // A solid screen hides the creepers; the spider has come around its end.
  fixture.bot.world.raycast = (_origin, direction) => direction.x > 0.5
    ? { x: 1, y: 65, z: 0, face: 4, intersect: new Vec3(1, 65, 0) } : null;
  const hits: number[] = [];
  fixture.bot.attack = entity => {
    hits.push(entity.id);
    fixture.bot.emit("entityDead", entity);
    entity.isValid = false;
    if (entity.id === spider.id) {
      fixture.target.position.set(0, 64, 2);
    }
  };
  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(7, new AbortController().signal, "pursue");
  assert.equal(outcome.kind, "died", JSON.stringify({ outcome, hits }));
  assert.deepEqual(hits, [9, 7], "answer the exposed attacker, then finish the requested quarry");
  assert.equal(outcome.targetId, 7);
  assert.equal(fixture.controls.includes("forward"), false, "no retreat from two terrain-hidden inactive creepers");
});

test("a ready creeper knockback is followed by shared clearance and a ranged finish", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow"]);
  fixture.target.name = "creeper";
  const stone = { name: "stone", boundingBox: "block" };
  const air = { name: "air", boundingBox: "empty" };
  fixture.bot.blockAt = ((position: Vec3) => (position.y < 64 ? stone : air)) as Bot["blockAt"];
  const second = { id: 8, name: "creeper", isValid: true, height: 1.7, position: new Vec3(0, 64, 3) } as Entity;
  fixture.bot.entities[second.id] = second;
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      fixture.bot.entity.position = fixture.bot.entity.position.offset(-1, 0, -1);
    }
  };

  fixture.script.onShot = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  // The scripted death follows the shot after a knockback hit and shared clearance.
  assert.equal(outcome.kind, "died");
  assert.deepEqual(outcome.stylesUsed, ["melee", "bow"]);
  assert.equal(outcome.attacks, 2);
});

test("a creeper whose fuse is running is not walked toward; the bot sprints clear until it unwinds", async () => {
  const fixture = creeperFixture();
  fixture.target.position = new Vec3(5, 64, 0);
  const metadata: unknown[] = [];
  metadata[fixture.bot.registry.entitiesByName["creeper"]!.metadataKeys!.indexOf("swell_dir")] = 1;
  fixture.target.metadata = metadata as Entity["metadata"];
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      fixture.bot.entity.position = fixture.bot.entity.position.offset(-1, 0, 0);
    }
    if (fixture.bot.entity.position.distanceTo(fixture.target.position) >= 8)
      fixture.bot.emit("entityGone", fixture.target);
  };
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
      throw new Error("The approach walked into a running fuse.");
    },
  } as unknown as NavigationRuntime;

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  assert.equal(outcome.attacks, 0);
  assert.ok(
    fixture.headings.every((heading) => heading.x < 0),
    "every heading ran from the fuse",
  );
});

test("with rock straight behind it, the sprint clear turns along the face instead of stopping", async () => {
  // A wall one block west of the bot, at head and feet height: the direct line
  // away from a creeper to the east is blocked, and so are both diagonals.
  const fixture = creeperFixture({ wall: (position) => position.x < -0.5 });
  fixture.script.onAttack = () => {
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
  };
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      const heading = fixture.headings.at(-1);
      if (heading)
        fixture.bot.entity.position = fixture.bot.entity.position.plus(new Vec3(heading.x, 0, heading.z).normalize());
    }
    if (fixture.bot.entity.position.distanceTo(fixture.target.position) >= 8)
      fixture.bot.emit("entityGone", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  // Without the fan the sprint stops at the rock, the loop walks back toward
  // the creeper, and this fixture's navigation refuses: the fight fails.
  assert.equal(outcome.kind, "target_lost", "the retreat reached clearance");
  assert.ok(fixture.bot.entity.position.x > -0.5, "the bot never ran into the wall");
  assert.ok(
    fixture.headings.some((heading) => Math.abs(heading.z) > 3 * Math.abs(heading.x)),
    `some heading ran along the face: ${fixture.headings.map((h) => `${h.x.toFixed(1)},${h.z.toFixed(1)}`).join(" ")}`,
  );
});

test("the sprint clear keeps running for a full fuse after the last creeper is beyond clearance", async () => {
  const fixture = creeperFixture();
  let clearedAtTick: number | null = null;
  let ticks = 0;
  fixture.script.onAttack = () => {
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
  };
  fixture.script.onWait = () => {
    ticks += 1;
    if (fixture.activeControls.has("forward")) {
      fixture.bot.entity.position = fixture.bot.entity.position.offset(-1, 0, 0);
    }
    // The creeper gives chase a little slower than the sprint, so it stays
    // inside its follow range and the unwinding is the only thing that ends the run.
    if (fixture.target.position.distanceTo(fixture.bot.entity.position) > 3) {
      fixture.target.position = fixture.target.position.offset(-0.8, 0, 0);
    }
    if (clearedAtTick === null && fixture.bot.entity.position.distanceTo(fixture.target.position) > 8) {
      clearedAtTick = ticks;
    }
  };
  let unwindTicks: number | null = null;
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
      // The re-approach marks the end of the retreat.
      unwindTicks = ticks - (clearedAtTick ?? ticks);
      fixture.bot.emit("entityGone", fixture.target);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  // The controller sees the clearance one tick before this fixture's observer does.
  assert.ok(unwindTicks !== null && unwindTicks >= 29, `unwound for ${unwindTicks} ticks beyond clearance`);
});

test("a bow draw is let go the moment a creeper walks into fuse range", async () => {
  const fixture = combatFixture(["iron_sword", "bow", "arrow"], { targetDistance: 7 });
  fixture.target.name = "creeper";
  const stone = { name: "stone", boundingBox: "block" };
  const air = { name: "air", boundingBox: "empty" };
  fixture.bot.blockAt = ((position: Vec3) => (position.y < 64 ? stone : air)) as Bot["blockAt"];
  let drawTicks = 0;
  fixture.script.onWait = () => {
    // The creeper closes a block a tick while the bow is drawn.
    if (fixture.bot.usingHeldItem) {
      drawTicks += 1;
      fixture.target.position = fixture.target.position.offset(-1, 0, 0);
    } else if (fixture.activeControls.has("forward")) {
      // Native death during escape settles the target; cancellation must already have released the draw.
      fixture.bot.emit("entityDead", fixture.target);
    }
  };

  // The target can also be finished by melee after the draw is cancelled.
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
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

  assert.equal(outcome.kind, "died");
  assert.ok(drawTicks < 20, `the draw was dropped after ${drawTicks} ticks`);
  const cancel = fixture.timeline.indexOf("slot:1");
  const release = fixture.timeline.indexOf("item-down", fixture.timeline.indexOf("item-use"));
  assert.ok(cancel >= 0, "the draw was cancelled by a slot change");
  assert.ok(release === -1 || release > cancel, "no arrow was loosed to drop the draw");
});

test("an approach stops for a fuse and attacks after observed clearance", async () => {
  const fixture = creeperFixture();
  fixture.target.position = new Vec3(6, 64, 0);
  const swellIndex = fixture.bot.registry.entitiesByName["creeper"]!.metadataKeys!.indexOf("swell_dir");
  let stopReason: unknown = null;
  let firstApproach = true;
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async (options: { stopSignal?: AbortSignal; signal: AbortSignal }) => {
      if (!firstApproach) {
        Reflect.set(fixture.target.metadata, swellIndex, -1);
        fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
        return { status: "completed", elapsedMs: 1 };
      }
      firstApproach = false;
      // Two blocks in, the creeper closes to reach and starts its fuse.
      fixture.bot.entity.position = new Vec3(2, 64, 0);
      fixture.target.position = new Vec3(4.5, 64, 0);
      const metadata: unknown[] = [];
      metadata[swellIndex] = 1;
      fixture.target.metadata = metadata as Entity["metadata"];
      fixture.bot.emit("physicsTick");
      stopReason = options.signal.reason ?? options.stopSignal?.reason ?? null;
      return options.stopSignal?.aborted
        ? { status: "stopped", reason: String(options.stopSignal.reason), elapsedMs: 1 }
        : { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      const heading = fixture.headings.at(-1);
      if (heading) fixture.bot.entity.position.add(new Vec3(heading.x, 0, heading.z).normalize());
    }
    if (fixture.bot.entity.position.distanceTo(fixture.target.position) > 8) Reflect.set(fixture.target.metadata, swellIndex, -1);
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.match(String(stopReason), /blast danger requires a defensive tactic/);
  assert.equal(outcome.kind, "died", "the stop was not mistaken for an unreachable target");
  assert.equal(outcome.attacks, 1);
});

test("an inactive distant creeper permits a supported approach without a separate sidestep mode", async () => {
  // A wall one block west of the bot; the creeper is coming from the east.
  // Half a block of margin keeps a heading straight along the face, whose x
  // component is a rounding error, out of the rock.
  const fixture = creeperFixture({ wall: (position) => position.x < -0.5 && Math.abs(position.z) < 3 });
  fixture.target.position = new Vec3(6, 64, 0);
  let sidewaysBeforeApproach = false;
  const navigation = {
    ...navigationFixture(),
    cancel: () => undefined,
    navigate: async () => {
      sidewaysBeforeApproach = fixture.headings.some((heading) => Math.abs(heading.z) > Math.abs(heading.x));
      fixture.bot.entity.position = fixture.target.position.offset(-2, 0, 0);
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward")) {
      const heading = fixture.headings.at(-1);
      if (heading)
        fixture.bot.entity.position = fixture.bot.entity.position.plus(new Vec3(heading.x, 0, heading.z).normalize());
    }
  };

  fixture.script.onAttack = () => fixture.bot.emit("entityDead", fixture.target);

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(sidewaysBeforeApproach, false, "shared policy admitted the approach without an emergency retreat");
  assert.equal(outcome.attacks, 1);
});

test("a sprint clear keeps the side it chose while it stays open, instead of zigzagging along a wall", async () => {
  // Rock straight behind; the creeper drifts a little across the away line
  // every tick, which would flip a fan chosen afresh from +z to -z and back.
  const fixture = creeperFixture({ wall: (position) => position.x < -0.5 });
  fixture.target.position = new Vec3(2, 64, 0.2);
  let ticks = 0;
  fixture.script.onAttack = () => {
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
  };
  fixture.script.onWait = () => {
    ticks += 1;
    fixture.target.position = fixture.target.position.offset(0, 0, ticks % 2 === 0 ? 0.4 : -0.4);
    if (fixture.activeControls.has("forward")) {
      const heading = fixture.headings.at(-1);
      if (heading)
        fixture.bot.entity.position = fixture.bot.entity.position.plus(new Vec3(heading.x, 0, heading.z).normalize());
    }
    if (fixture.bot.entity.position.distanceTo(fixture.target.position) >= 9)
      fixture.bot.emit("entityGone", fixture.target);
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  const sideways = fixture.headings.filter((heading) => Math.abs(heading.z) > Math.abs(heading.x));
  assert.ok(sideways.length >= 3, "the retreat ran along the wall");
  assert.ok(
    sideways.every((heading) => Math.sign(heading.z) === Math.sign(sideways[0]!.z)),
    `one side, kept: ${sideways.map((h) => h.z.toFixed(1)).join(" ")}`,
  );
});

test("cornered in a dead-end tunnel, the bot keeps knocking the creeper back down it instead of running", async () => {
  // A one-wide notch: rock west of the bot and on both sides. The creeper
  // comes down the open end to the east.
  const fixture = creeperFixture({ wall: (position) => position.x < 0 || Math.abs(position.z) >= 1 });
  fixture.target.position = new Vec3(2, 64, 0);
  const swellIndex = fixture.bot.registry.entitiesByName["creeper"]!.metadataKeys!.indexOf("swell_dir");
  const metadata: unknown[] = [];
  metadata[swellIndex] = 1;
  fixture.target.metadata = metadata as Entity["metadata"];
  fixture.script.onAttack = () => {
    // Each sprint hit knocks it three blocks back down the tunnel; the fourth kills it.
    fixture.target.position = fixture.target.position.offset(3, 0, 0);
    if (fixture.directAttacks.count === 4) fixture.bot.emit("entityDead", fixture.target);
  };
  const navigation = {
    ...navigationFixture(),
    navigate: async () => assert.fail("a defensive counter-hit must not chase into the running fuse"),
  } as unknown as NavigationRuntime;
  fixture.script.onWait = () => {
    // The creeper closes again after knockback; the supported defender does
    // not advance into the fuse to manufacture another attack opportunity.
    if (fixture.target.position.x > 2) fixture.target.position.x -= 0.5;
  };

  const outcome = await createCombatController(fixture.bot, navigation).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 4);
  assert.equal(fixture.bot.entity.position.x, 0);
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

test("an explosion announced during the fight is counted, so a vanished creeper is not mistaken for a wanderer", async () => {
  const fixture = creeperFixture();
  fixture.script.onAttack = () => {
    fixture.bot._client.emit("explosion", {});
    fixture.bot.emit("entityGone", fixture.target);
  };
  fixture.script.onWait = () => {
    if (fixture.activeControls.has("forward"))
      fixture.bot.entity.position.x -= 1;
  };

  const outcome = await createCombatController(fixture.bot, navigationFixture()).engage(
    7,
    new AbortController().signal,
    "pursue",
  );

  assert.equal(outcome.kind, "target_lost");
  assert.equal(outcome.explosions, 1);
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
  await controller.policy.edit({
    operation: "set",
    expected_revision: controller.policy.snapshot().revision,
    changes: { combat: { evade_timeout_ms: 5_000 } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  await cancelled;
  assert.equal(controller.activeEngagement(), null);
  assert.equal(controller.policy.settling, false);
  assert.equal(controller.policy.combat.evade_timeout_ms, 5_000);
});

test("an optional cover route failure leaves ordinary combat available", async () => {
  const { CoverFight } = await import("../../responses/fight/cover.js");
  const fixture = blazePreflightFixture(["iron_sword"]);
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++)
    for (let y = 64; y <= 72; y++) fixture.world.load({ x, y, z }, { stateId: 0, traits: { empty: true } });
  armWithBow(fixture.target);
  let attempts = 0;
  const position = {
    plan: null, canEstablish: true, adoptExisting: () => {},
    threats: () => [positionThreat(fixture.bot, fixture.target)],
    planCover: () => ({ kind: "ready" }),
  };
  const scene = {
    bot: fixture.bot, target: fixture.target, position, navigation: fixture.navigation,
    movement: "pursue", protectedProgress: { leave: () => {} },
    reportDecision: () => {},
  } as unknown as ConstructorParameters<typeof CoverFight>[0];
  const weapons = { contact: () => null, currentLoadout: () => ({ shield: null }) } as unknown as ConstructorParameters<typeof CoverFight>[1];
  const cover = new CoverFight(scene, weapons, {} as ConstructorParameters<typeof CoverFight>[2]);
  Object.assign(cover, { establishCover: async () => {
    attempts++; position.canEstablish = false;
    return { kind: "unreachable", reason: "Cover position approach stopped: no path" };
  } });
  assert.deepEqual(await cover.keepPosition(new AbortController().signal), { kind: "proceed" });
  assert.equal(attempts, 1);
  assert.deepEqual(await cover.keepPosition(new AbortController().signal), { kind: "proceed" });
  assert.equal(attempts, 1, "unchanged rejected cover does not retry");
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
