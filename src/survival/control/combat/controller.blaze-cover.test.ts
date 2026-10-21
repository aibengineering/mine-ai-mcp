/** Cover against ranged shooters: material admission, construction, passage fire and the cover engagement cycle. */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Vec3 } from "vec3";
import { type NavigationRuntime, SupportedPositionHold } from "../../../navigation/index.js";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import {
  TestCombatPosition as CombatPosition,
  combatResourceRefusalForTest as combatResourceRefusal,
  createTestCombatController as createCombatController,
  disposeCombatTestResources,
} from "../../../test-support/combat.js";
import { ScriptedBlaze } from "../../../test-support/scripted-blaze.js";
import { positionThreat } from "../../perception/combat/observations.js";
import { FootingRecovery } from "../../responses/footing.js";
import {
  armWithBow,
  blazeCoverArena,
  blazePreflightFixture,
  combatFixture,
  navigationFixture,
  plannedCoverCell,
  stack,
  stopCombatFixtureClocks,
} from "./controller.test-support.js";

afterEach(stopCombatFixtureClocks);

for (const blocks of [0, 1]) {
  test(`skeleton crossfire with ${blocks} building blocks keeps guarded combat available`, async () => {
    const fixture = blazePreflightFixture(["iron_sword", "shield", "cobblestone"]);
    const { bot, target } = fixture;
    target.name = "skeleton";
    armWithBow(target);
    stack(bot, "cobblestone").count = blocks;
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
  const blocks = stack(bot, "cobblestone");
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
  stack(bot, "cobblestone").count = 64;
  bot.entity.position.y = 63.875;
  bot.entity.onGround = true;
  const stateId = bot.registry.blocksByName.soul_sand!.defaultState;
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) world.load({ x, y: 63, z }, { stateId });
  const planned = new CombatPosition(bot, navigation, target, new Set()).planCover();
  assert.equal(planned.kind, "ready");
  if (planned.kind === "ready") assert.equal(planned.plan.protected.y, 64);
});

test("a refused cover search cannot renew its construction attempt without changed material", async () => {
  const fixture = blazePreflightFixture(["iron_sword", "cobblestone"]);
  const { bot, target } = fixture;
  stack(bot, "cobblestone").count = 64;
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
  const blocks = stack(bot, "cobblestone");
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
  const fixture = combatFixture(["iron_sword", "cobblestone"]);
  const { bot, target, script, clock } = fixture;
  stack(bot, "cobblestone").count = 64;
  const { world, plan } = blazeCoverArena(fixture, -8);
  const navigation = navigationFixture();
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
      const destination = plannedCoverCell(options, plan);
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
  assert.equal(stack(bot, "cobblestone").count, 64);
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
    target.kind = "Hostile mobs";
    const { world, plan } = blazeCoverArena(
      fixture,
      interruption === "close target" ? -4.5 : -8,
      interruption !== "establish knockback",
    );
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
        const destination = plannedCoverCell(options, plan);
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
          script.onWait?.();
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

test("arrows on open ground cannot keep restarting a cover search that finds nothing", async () => {
  // Recorded in hunt/skeleton-hunts (BoneGatherer, t00007): the bot stood at
  // (70.5, -60, -9.5) on a superflat field with skeletons at (77.8, -19.7),
  // (64.4, -16.5) and (58.5, -4.5). No cell within 32 blocks shelters it from
  // all three, so every cover search either exhausted its 4225 nodes or was
  // cut short by the next arrow, and each restart cost a blocked arrow until
  // the shield broke. A strafing archer or another arrow does not put cover
  // on open ground; after a few fruitless searches the guarded approach runs.
  const { CoverFight, FRUITLESS_COVER_SEARCH_LIMIT } = await import("../../responses/fight/cover.js");
  const fixture = blazePreflightFixture(["iron_sword", "shield"]);
  const { bot, target } = fixture;
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++)
    for (let y = 64; y <= 72; y++) fixture.world.load({ x, y, z }, { stateId: 0, traits: { empty: true } });
  target.name = "skeleton";
  armWithBow(target);
  target.position.set(7.8, 64, -9.7);
  const archers = [target, ...[new Vec3(-5.6, 64, -6.5), new Vec3(-11.5, 64, 5.5)].map((position, index) => {
    const archer = Object.assign(combatFixture([]).target, target, { id: 8 + index, position });
    armWithBow(archer);
    return archer;
  })];
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  let searches = 0;
  const position = {
    plan: null, canEstablish: true, rejectedCoverCount: 0, adoptExisting: () => {},
    threats: () => archers.map((archer) => positionThreat(bot, archer)),
    planCover: () => ({ kind: "unreachable" }),
  };
  const scene = {
    bot, target, position, navigation: fixture.navigation,
    movement: "pursue", protectedProgress: { leave: () => {} },
    reportDecision: () => {},
  } as unknown as ConstructorParameters<typeof CoverFight>[0];
  const weapons = { contact: () => null, currentLoadout: () => ({ shield }) } as unknown as ConstructorParameters<typeof CoverFight>[1];
  const cover = new CoverFight(scene, weapons, {} as ConstructorParameters<typeof CoverFight>[2]);
  Object.assign(cover, { establishCover: async () => {
    searches++;
    // Odd searches are cut short by an arrow; even ones exhaust the search,
    // whose refusal the archer's one-block strafe reopens at once.
    if (searches % 2 === 1) throw new DOMException("Incoming projectile interrupted the combat position effect.", "AbortError");
    return { kind: "unreachable", reason: "Cover position approach stopped: search radius limit 32 blocks reached" };
  } });
  const turns: string[] = [];
  for (let turn = 0; turn < 8; turn++)
    turns.push(await cover.keepPosition(new AbortController().signal).then((kept) => kept.kind, () => "interrupted"));
  assert.equal(searches, FRUITLESS_COVER_SEARCH_LIMIT, `turns: ${turns.join(", ")}`);
  assert.equal(turns.at(-1), "proceed", "the guarded approach takes over");
});
