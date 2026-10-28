/** Combat against Endermen: roof admission, protected waits, teleport returns and anger attribution. */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import {
  TestCombatPosition as CombatPosition,
  combatResourceRefusalForTest as combatResourceRefusal,
  createTestCombatController as createCombatController,
  disposeCombatTestResources,
} from "../../test-support/combat.js";
import type { CombatDecision } from "./contract.js";
import {
  blazePreflightFixture,
  combatFixture,
  controllerAfterObservedHit,
  navigationFixture,
  openArena,
  setEndermanAnger,
  stack,
  stopCombatFixtureClocks,
} from "./controller.test-support.js";
import { CombatPerception } from "../perception/combat/observations.js";

afterEach(stopCombatFixtureClocks);

test("roof admission avoids passable twisting vines before provoking an Enderman", () => {
  const { bot, target, navigation, world } = blazePreflightFixture(["iron_sword", "cobblestone"]);
  target.name = "enderman";
  target.height = 2.9;
  stack(bot, "cobblestone").count = 64;
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
    setEndermanAnger(fixture.bot, enderman, angry);
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
    setEndermanAnger(fixture.bot, fixture.target, true);
    if (clearsFlag) fixture.script.onWait = () => setEndermanAnger(fixture.bot, fixture.target, false);
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
  setEndermanAnger(fixture.bot, fixture.target, true);
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
  setEndermanAnger(fixture.bot, fixture.target, true);
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

test("a hunt out of blocks returns to the roof it built instead of reporting missing material", () => {
  // The 2026-10-20 ShelterPair pen: eleven cobblestone roofed cell 200,0;
  // the first kill ended at 204.21,-2.19, seven steps from that roof, with the
  // second enderman at 210,-5. The local six-step search found no roof, and
  // with no blocks left the hunt stopped on [COMBAT_BUILD_MATERIALS_MISSING]
  // although the roof still stood and its gaze to the quarry was clear.
  const { bot, target, navigation, world } = blazePreflightFixture(["diamond_sword", "shield"]);
  target.name = "enderman";
  target.height = 2.9;
  target.position.set(10.5, 64, -4.5);
  bot.entity.position.set(4.21, 64, -2.19);
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.load({ x, y: 66, z }, { stateId: 1 });
  assert.equal(combatResourceRefusal(bot, navigation, target), null);
  const planned = new CombatPosition(bot, navigation, target, new Set()).planRoof({
    kind: "provoke",
    targetEye: target.position.offset(0, 2.55, 0),
    eyeHeight: 1.62,
  });
  assert.equal(planned.kind, "unreachable", "the standing roof is a destination, not missing material");
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
  setEndermanAnger(fixture.bot, fixture.target, true);
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
  stack(bot, "cobblestone").count = 64;
  openArena(navigation.world as MemoryWorld, 10, 70);
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
    setEndermanAnger(fixture.bot, fixture.target, false);
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

test("a quarry stalled behind the roof's own wall is baited out around it", async () => {
  // The 2026-10-20 Alcove pen: the bot held its nook at 0.46,0.51 and the
  // enderman, pathing to the bot's cell, stopped behind the nook's north wall
  // at 0.57,-1.6: from the bot's cell that node ties with the open mouth. No
  // footing was nearer the quarry, so no bait was walked, the 300-tick roof
  // wait ran out, and with no blocks for another roof the hunt gave up.
  const fixture = protectedEndermanFixture();
  const { bot, target } = fixture;
  const world = openArena(new MemoryWorld(), 6, 68);
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++)
      for (const y of [64, 65]) if (z !== 0 || x < 0) world.load({ x, y, z }, { stateId: 1 });
  for (const x of [0, 1]) world.load({ x, y: 66, z: 0 }, { stateId: 1 });
  const navigation = { ...fixture.navigation, world };
  target.position.set(0.57, 64, -1.6);
  bot.world.raycast = (() =>
    bot.entity.position.x < 2 ? { x: 0, y: 65, z: -1, face: 3, intersect: new Vec3(0.5, 65, 0) } : null) as Bot["world"]["raycast"];
  const stopped = new AbortController();
  const baits: unknown[] = [];
  const controller = controllerAfterObservedHit(bot, navigation);
  controller.onDecision((event) => {
    if (event.kind !== "response") return;
    const evidence = event.evidence as { boundary?: unknown; stage?: unknown; path?: unknown };
    if (evidence.boundary !== "enderman_roof_bait" || evidence.stage !== "out") return;
    baits.push(evidence.path);
    stopped.abort();
  });
  await controller.engage(7, stopped.signal, "pursue");
  assert.deepEqual(baits, [[{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }]]);
  assert.ok(fixture.clock.tick < 300, "the bait comes before the roof wait runs out");
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

test("a roof approach yields its facing when another attacker enters reach", async () => {
  const fixture = blazePreflightFixture(["iron_sword", "shield", "cobblestone"]);
  const { bot, target, navigation, world } = fixture;
  target.name = "enderman";
  target.height = 2.9;
  target.metadata = [];
  stack(bot, "cobblestone").count = 64;
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

for (const offset of [new Vec3(8, 0, 0), new Vec3(2, 5, 0)]) {
  test(`an enderman without reachable protection is neither chased nor shot at ${offset}`, async () => {
    const fixture = combatFixture(["iron_sword", "shield", "bow", "arrow"]);
    fixture.target.name = "enderman";
    fixture.target.kind = "Hostile mobs";
    fixture.target.metadata = [];
    setEndermanAnger(fixture.bot, fixture.target, true);
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
