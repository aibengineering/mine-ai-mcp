/** Creeper fuses: sprint clearance, retreat headings, counter-hits and incidental creepers. */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { createTestCombatController as createCombatController } from "../../../test-support/combat.js";
import { retreatFromCreepers } from "../../responses/fight/creeper-retreat.js";
import { combatFixture, navigationFixture, stopCombatFixtureClocks, type Entity } from "./controller.test-support.js";

afterEach(stopCombatFixtureClocks);

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
