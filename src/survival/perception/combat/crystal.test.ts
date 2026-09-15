import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { TestEndCombat as EndCombat } from "../../../test-support/combat.js";
import type { CombatController } from "../../control/combat/contract.js";
import { CrystalObservation } from "./crystal.js";

import { createDestroyEndCrystalAction } from "../../../actions/destroy-end-crystal/index.js";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { ActionRunner } from "../../../session/action-runner.js";
import type { FootingRecovery } from "../../responses/footing.js";

function fixture(t: TestContext) {
  const bot = botFixture();
  bot.health = 20;
  bot.food = 20;
  bot._client = new EventEmitter() as Bot["_client"];
  bot.time = { age: 100 } as Bot["time"];
  bot.waitForTicks = async () => {};
  // The simulated server advances independently of the executor's waits.
  // Individual tests arrange packets on this clock, including while suspended.
  const physics = setInterval(async () => {
    await bot.waitForTicks(1);
    bot.emit("physicsTick");
  }, 1);
  t.after(() => clearInterval(physics));
  const target = { id: 42, name: "end_crystal", isValid: true, position: new Vec3(30, 80, 0) } as Parameters<
    Bot["attack"]
  >[0];
  bot.entities[42] = target;
  const end = new EndCombat(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  const explode = () => bot._client.emit("explosion", { x: 30, y: 80, z: 0 });
  const time = (age: number) => {
    bot.time.age = age;
    bot.emit("time");
  };
  return { bot, target, end, explode, time };
}

for (const change of ["identity", "dimension"] as const) {
  test(`a ${change} change cannot complete or reissue the selected crystal request`, async (t) => {
    const f = fixture(t);
    using observation = new CrystalObservation(f.bot, 42);
    observation.released(8);
    const replacement = Object.assign(Object.create(Object.getPrototypeOf(f.target)), f.target);
    if (change === "identity") f.bot.entities[42] = replacement;
    else f.bot.game.dimension = "the_nether";
    f.bot.emit("entityDead", change === "identity" ? replacement : f.target);
    f.explode();
    assert.equal(observation.destroyed, false);
    const result = await f.end.crystal(42, new AbortController().signal, observation);
    assert.equal(result.outcome, "stopped");
    assert.equal(result.attacks, 1);
    assert.match(result.reason ?? "", change === "identity" ? /identity/ : /Dimension changed/);
  });
}

test("crystal removal does not end observation before a delayed explosion receipt", async (t) => {
  const f = fixture(t);
  using observation = new CrystalObservation(f.bot, 42);
  observation.released(8);
  let ticks = 0;
  f.bot.waitForTicks = async () => {
    if (++ticks === 1) {
      f.target.isValid = false;
      delete f.bot.entities[42];
    }
    // Far beyond the old ten client-tick window, but the server has not advanced.
    if (ticks === 35) f.explode();
  };
  const result = await f.end.crystal(42, new AbortController().signal, observation);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 1);
  assert.equal(ticks, 35);
});

for (const removed of [false, true])
  test(`settled shot distinguishes a loaded miss from lost observation: ${removed}`, async (t) => {
    const f = fixture(t);
    using observation = new CrystalObservation(f.bot, 42);
    observation.released(8);
    let ticks = 0;
    f.bot.waitForTicks = async () => {
      ticks++;
      if (removed) {
        f.target.isValid = false;
        delete f.bot.entities[42];
      }
      if (ticks === 10) f.time(120);
      if (ticks === 20) f.time(140);
    };
    const result = await f.end.crystal(42, new AbortController().signal, observation);
    assert.equal(ticks, 20);
    assert.equal(result.outcome, removed ? "stopped" : "shot_missed");
  });

for (const reappears of [false, true]) test(`lost shot revisits the native site before settling; crystal reappears: ${reappears}`, async (t) => {
  const f = fixture(t);
  const geometry = botFixture({ blocks: { "30,79,0": "bedrock" } });
  f.bot.blockAt = position => geometry.blockAt(position.floored());
  using observation = new CrystalObservation(f.bot, 42, "bow");
  observation.released(8);
  observation.shot!.settled = true;
  f.target.isValid = false;
  delete f.bot.entities[42];
  let visited = false;
  const navigation = { navigate: async () => {
    visited = true;
    f.bot.entity.position.set(10, 64, 0);
    return { status: "completed", elapsedMs: 1 } as const;
  } } as unknown as NavigationRuntime;
  f.bot.waitForTicks = async () => {
    f.time(f.bot.time.age + 1);
    if (visited && reappears) f.bot.entities[42] = { ...f.target, isValid: true } as Bot["entity"];
  };
  const result = await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(42, new AbortController().signal, observation);
  assert.equal(visited, true);
  assert.equal(result.outcome, reappears ? "shot_missed" : "crystal_destroyed");
  assert.equal(observation.destroyed, !reappears);
  if (!reappears) assert.match(result.reason!, /verified it empty/);
});

test("a successful dragon takeover resumes the same crystal request and retains a shot's receipts", async (t) => {
  const f = fixture(t);
  const runner = new ActionRunner();
  let attempts = 0;
  let first: CrystalObservation | null = null;
  const combat = {
    async runEnd(request, signal) {
      assert.equal(request.kind, "crystal");
      if (request.kind !== "crystal") throw new Error("wrong request");
      attempts++;
      if (attempts === 1) {
        first = request.observation;
        first.released(8);
        const cancelled = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        const claim = runner.claim("dragon_reflex", "Dragon breath", async () => {
          f.target.isValid = false;
          delete f.bot.entities[42];
          f.explode();
          return { value: null, continuation: { kind: "resume" as const } };
        });
        assert.equal(claim.kind, "claimed");
        await cancelled;
        signal.throwIfAborted();
      }
      assert.equal(request.observation, first);
      return f.end.crystal(42, signal, request.observation);
    },
  } as CombatController;
  const result = await runner.run(createDestroyEndCrystalAction(f.bot, combat), { entity_id: 42 });
  assert.equal(result.result.status, "succeeded");
  assert.equal(attempts, 2);
  assert.deepEqual(result.interruptions, ["Dragon breath"]);
  assert.equal(first!.attacks, 1);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
  assert.equal(f.bot.listenerCount("time"), 0);
  assert.equal(f.bot._client.listenerCount("explosion"), 0);
});

test("caller cancellation while waiting for server progress is final and releases receipts", async (t) => {
  const f = fixture(t);
  const caller = new AbortController();
  let attempts = 0;
  const combat = {
    async runEnd(request, signal) {
      if (request.kind !== "crystal") throw new Error("wrong request");
      attempts++;
      request.observation.released(8);
      f.bot.waitForTicks = async () => {
        caller.abort("cancelled by user");
      };
      return f.end.crystal(42, signal, request.observation);
    },
  } as CombatController;
  const result = await new ActionRunner().run(
    createDestroyEndCrystalAction(f.bot, combat),
    { entity_id: 42 },
    caller.signal,
  );
  assert.equal(result.result.status, "cancelled");
  assert.ok("combat" in result.result, "Cancellation preserves the released shot's evidence.");
  if ("combat" in result.result) assert.equal(result.result.combat.attacks, 1);
  assert.equal(attempts, 1);
  assert.equal(f.bot._client.listenerCount("explosion"), 0);
});

test("explicit bow refuses before movement when ammunition is unavailable", async (t) => {
  const f = fixture(t);
  f.bot.inventory.items = () => [{ name: "bow", count: 1 }] as ReturnType<Bot["inventory"]["items"]>;
  let moves = 0;
  const navigation = {
    navigate: async () => {
      moves++;
      return { status: "completed", elapsedMs: 1 } as const;
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "bow");
  const result = await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  );
  assert.equal(result.outcome, "weapon_unavailable");
  assert.match(result.reason ?? "", /CRYSTAL_BOW_UNAVAILABLE/);
  assert.equal(result.crystal?.usedWeapon, null);
  assert.equal(moves, 0);
});

test("crystal bow search accepts distant clear shots without preferring a blocked closer stance", async (t) => {
  const f = fixture(t);
  f.bot.inventory.items = () => [{ name: "bow", count: 1 }, { name: "arrow", count: 8 }] as ReturnType<Bot["inventory"]["items"]>;
  f.bot.clearControlStates = () => {};
  f.bot.deactivateItem = () => {};
  f.bot.entity.position.set(100, 64, 0);
  f.bot.findBlocks = options => {
    const openingFloor = new Vec3(-15, 63, 0);
    assert.ok(options.maxDistance! >= f.bot.entity.position.distanceTo(openingFloor), "include shots on the far side of a tower across the island");
    return [openingFloor];
  };
  let blocked = true;
  f.bot.world.raycast = () => blocked ? ({ name: "obsidian" } as never) : null;
  let checked = false;
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      const near = { feet: { x: 10, y: 64, z: 0 } } as never;
      const far = { feet: { x: -15, y: 64, z: 0 } } as never;
      assert.equal(resolved.isSatisfied(near, {} as never), false);
      blocked = false;
      assert.equal(resolved.isSatisfied(far, {} as never), true, "a clear shot over 30 horizontal blocks is eligible");
      assert.ok(resolved.heuristic(far) < resolved.heuristic(near), "guide toward the valid opening, even when it is farther from the tower");
      checked = true;
    }
    return { status: "failed", reason: "search checked", elapsedMs: 1 } as const;
  } } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "bow");
  await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(42, new AbortController().signal, observation);
  assert.equal(checked, true);
});

test("explicit melee reports staircase supplies instead of falling back to a carried bow", async (t) => {
  const f = fixture(t);
  f.target.position.set(30.5, 80, 0.5);
  const geometry = botFixture({ groundY: 63, blocks: { "30,79,0": "bedrock", "32,76,0": "obsidian" } });
  f.bot.blockAt = position => geometry.blockAt(position.floored());
  f.bot.inventory.items = () =>
    [
      { name: "bow", count: 1 },
      { name: "arrow", count: 8 },
      { name: "cobblestone", count: 32 },
    ] as ReturnType<Bot["inventory"]["items"]>;
  let moves = 0;
  const navigation = {
    navigate: async () => {
      moves++;
      return { status: "failed", reason: "fixture has no pillar", elapsedMs: 1 } as const;
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "melee");
  const result = await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  );
  assert.equal(result.outcome, "stopped");
  assert.equal(result.crystal?.usedWeapon, "melee");
  assert.match(result.reason ?? "", /CRYSTAL_STAIRCASE_SHORTFALL.*end_stone.*carrying 0/);
  assert.equal(observation.shot, null, "explicit melee never enters the bow release path");
  assert.equal(moves, 0, "resource preflight must run before starting the climb");
});

test("melee construction counts bot placements and recovered matching drops, not unrelated world changes", (t) => {
  const f = fixture(t);
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  const air = { name: "air", boundingBox: "empty", position: new Vec3(2, 64, 0) } as NonNullable<
    ReturnType<Bot["blockAt"]>
  >;
  const otherStone = { name: "cobblestone", boundingBox: "block", position: air.position } as NonNullable<
    ReturnType<Bot["blockAt"]>
  >;
  f.bot.emit("blockUpdate", air, otherStone);
  assert.equal(observation.scaffoldPlaced, 0, "another actor's observed world update is not our placement");

  f.bot.emit("blockPlaced" as "blockUpdate", air, otherStone);
  f.bot.emit("blockUpdate", otherStone, air);
  assert.deepEqual(observation.meleeEvidence(), {
    ...observation.meleeEvidence(),
    scaffoldPlaced: 1,
    scaffoldRecovered: 0,
  });
  const farDrop = {
    id: 70,
    position: new Vec3(20, 64, 0),
    getDroppedItem: () => ({ name: "cobblestone", count: 1 }),
  } as unknown as Bot["entity"];
  f.bot.emit("playerCollect", f.bot.entity, farDrop);
  assert.equal(observation.scaffoldRecovered, 0, "an unrelated pickup cannot recover the route scaffold");
  const routeDrop = {
    ...farDrop,
    id: 71,
    position: air.position.offset(0.5, 0, 0.5),
    getDroppedItem: () => ({ name: "cobblestone", count: 1 }),
  } as unknown as Bot["entity"];
  f.bot.emit("playerCollect", f.bot.entity, routeDrop);
  assert.equal(observation.scaffoldRecovered, 1);
});

test("cage digging matches a pre-observed iron-bar cell when completion reports replacement air", (t) => {
  const f = fixture(t);
  const cage = new Vec3(30, 79, 1);
  f.bot.blockAt = (position) =>
    ({
      name: position.equals(cage) ? "iron_bars" : "air",
      boundingBox: position.equals(cage) ? "block" : "empty",
      position: position.clone(),
    }) as NonNullable<ReturnType<Bot["blockAt"]>>;
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  const replacementAir = { name: "air", boundingBox: "empty", position: cage } as NonNullable<
    ReturnType<Bot["blockAt"]>
  >;
  f.bot.emit("diggingCompleted", replacementAir);
  f.bot.emit("diggingCompleted", replacementAir);
  assert.equal(observation.cageBlocksDug, 1, "one observed cage cell has only one completion receipt");
});

test("melee blast damage requires the selected crystal's damage packet and exact explosion receipt", (t) => {
  const f = fixture(t);
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  f.explode();
  f.bot._client.emit("damage_event", {
    entityId: f.bot.entity.id,
    sourceTypeId: 0,
    sourceCauseId: 8,
    sourceDirectId: 8,
  });
  f.bot.health = 17;
  f.bot.emit("health");
  assert.equal(observation.explosionHealthLost, null, "mixed dragon damage remains unattributed");
  f.bot._client.emit("damage_event", {
    entityId: f.bot.entity.id,
    sourceTypeId: 0,
    sourceCauseId: 0,
    sourceDirectId: 43,
  });
  f.bot.health = 15;
  f.bot.emit("health");
  assert.equal(observation.explosionHealthLost, 2);
});

test("breath cancels only the bow draw, escapes, then destroys the same crystal with one arrow", async (t) => {
  const f = fixture(t);
  f.bot.inventory.slots = [];
  f.bot.inventory.items = () =>
    [
      { name: "bow", count: 1 },
      { name: "arrow", count: 3 },
    ] as ReturnType<Bot["inventory"]["items"]>;
  f.bot.equip = async () => {};
  f.bot.look = async () => {};
  f.bot.world.raycast = () => null;
  f.bot.clearControlStates = () => {};
  let drawing = false,
    releases = 0,
    ticks = 0,
    escapes = 0,
    releaseTick = -1;
  f.bot.activateItem = () => {
    drawing = true;
  };
  f.bot.setQuickBarSlot = () => {
    drawing = false;
  };
  f.bot.deactivateItem = () => {
    if (drawing) {
      releases++;
      releaseTick = ticks;
    }
    drawing = false;
  };
  f.bot.waitForTicks = async () => {
    ticks++;
    if (ticks === 5)
      f.bot.entities[7] = {
        id: 7,
        isValid: true,
        name: "area_effect_cloud",
        position: f.bot.entity.position.clone(),
        metadata: { 8: 5, 10: { type: "dragon_breath" } },
      } as unknown as Parameters<Bot["attack"]>[0];
    if (releaseTick >= 0 && ticks === releaseTick + 1) {
      f.target.isValid = false;
      delete f.bot.entities[42];
    }
    if (releaseTick >= 0 && ticks === releaseTick + 3) f.explode();
  };
  const navigation = {
    navigate: async () => {
      escapes++;
      assert.equal(drawing, false, "escape must not release a partial arrow");
      assert.equal(releases, 0);
      delete f.bot.entities[7];
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42);
  const result = await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  );
  assert.equal(escapes, 1);
  assert.equal(releases, 1);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 1);
});

test("a crystal destroyed during the resumed draw cancels the draw without firing at its old position", async (t) => {
  const f = fixture(t);
  f.bot.inventory.slots = [];
  f.bot.inventory.items = () =>
    [
      { name: "bow", count: 1 },
      { name: "arrow", count: 3 },
    ] as ReturnType<Bot["inventory"]["items"]>;
  f.bot.equip = async () => {};
  f.bot.look = async () => {};
  f.bot.world.raycast = () => null;
  f.bot.clearControlStates = () => {};
  let drawing = false,
    releases = 0,
    ticks = 0,
    escapes = 0,
    releaseTick = -1;
  f.bot.activateItem = () => {
    drawing = true;
  };
  f.bot.setQuickBarSlot = () => {
    drawing = false;
  };
  f.bot.deactivateItem = () => {
    if (drawing) {
      releases++;
      releaseTick = ticks;
    }
    drawing = false;
  };
  f.bot.waitForTicks = async () => {
    ticks++;
    if (ticks === 15) {
      f.target.isValid = false;
      delete f.bot.entities[42];
      f.explode();
    }
    if (ticks === 5)
      f.bot.entities[7] = {
        id: 7,
        isValid: true,
        name: "area_effect_cloud",
        position: f.bot.entity.position.clone(),
        metadata: { 8: 5, 10: { type: "dragon_breath" } },
      } as unknown as Parameters<Bot["attack"]>[0];
    if (releaseTick >= 0 && ticks === releaseTick + 1) {
      f.target.isValid = false;
      delete f.bot.entities[42];
    }
    if (releaseTick >= 0 && ticks === releaseTick + 3) f.explode();
  };
  const navigation = {
    navigate: async () => {
      escapes++;
      assert.equal(drawing, false, "escape must not release a partial arrow");
      assert.equal(releases, 0);
      delete f.bot.entities[7];
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42);
  const result = await new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  );
  assert.equal(escapes, 1);
  assert.equal(releases, 0);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 0);
});
