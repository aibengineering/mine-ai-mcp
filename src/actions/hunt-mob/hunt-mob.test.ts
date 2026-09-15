import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { hunt, type HuntTarget } from "../../navigation/processes/hunting/hunt-process.js";
import { ActionRunner } from "../../session/action-runner.js";
import type { CombatController, CombatOutcome } from "../../survival/index.js";
import { Budgets } from "../../survival/state/budgets.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { parseHuntMobRequest, type HuntMobRequest } from "./contract.js";
import {
  createCollectMobDropAction,
  engageTarget,
  formatHuntMobResult,
  gatherLoadedDrops,
  huntMob,
  huntMobDependencies,
  type HuntMobDependencies,
  type TargetEngagement,
} from "./hunt-mob.js";

type Entity = Parameters<Bot["attack"]>[0];

test("a hunt delegates health recovery to combat and preserves its terminal evidence", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 20 }) as unknown as Bot;
  const target = mob(7, 1, "blaze", 2, "Hostile mobs");
  const combat: CombatController = {
    resourceRefusal: () => null,
    policy: new SurvivalPolicyState(bot),
    runEnd: async () => {
      throw new Error("Unexpected End combat");
    },
    endDanger: () => false,
    activePosition: () => null,
    execution: () => null,
    onDecision: () => () => {},
    finish: async () => ({
      observedAt: 1,
      kind: "safe" as const,
      basis: "clear" as const,
      position: { x: 0, y: 64, z: 0 },
    }),
    canRecover: () => false,
    activeEngagement: () => null,
    stop: async () => {},
    engage: async (_id, signal) => {
      bot.health = 11;
      bot.emit("health");
      assert.equal(signal.aborted, false, "the hunt does not independently cancel combat recovery");
      return outcome("capability_blocked", 2, { reason: "recovery", observation: "No food remains." });
    },
  };
  const result = await engageTarget(bot, combat, target, {});
  assert.equal(result.outcome.kind, "capability_blocked");
  assert.equal(result.outcome.attacks, 2);
  if (result.outcome.kind === "capability_blocked") assert.equal(result.outcome.reason, "recovery");
  assert.equal(bot.listenerCount("health"), 0);
  assert.equal(bot.listenerCount("entityDead"), 0);
});

test("the hostile fight boundary does not cancel a passive quarry engagement", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 20 }) as unknown as Bot;
  const combat: CombatController = {
    resourceRefusal: () => null,
    policy: new SurvivalPolicyState(bot),
    runEnd: async () => {
      throw new Error("Unexpected End combat");
    },
    endDanger: () => false,
    activePosition: () => null,
    execution: () => null,
    onDecision: () => () => {},
    finish: async () => ({
      observedAt: 1,
      kind: "safe" as const,
      basis: "clear" as const,
      position: { x: 0, y: 64, z: 0 },
    }),
    canRecover: () => false,
    activeEngagement: () => null,
    stop: async () => {},
    engage: async (_id, signal) => {
      bot.health = 11;
      bot.emit("health");
      assert.equal(signal.aborted, false);
      return outcome("died", 2);
    },
  };
  const result = await engageTarget(bot, combat, mob(7, 1, "cow", 2), {});
  assert.equal(result.outcome.kind, "died");
});

function mob(id: number, entityType: number, name: string, x: number, kind = "Passive mobs"): Entity {
  return {
    id,
    entityType,
    name,
    kind,
    isValid: true,
    position: new Vec3(x, 64, 0),
    height: 1.3,
  } as Entity;
}

function huntBot(targets: readonly Entity[], inventory: { count: number }, health = 20): Bot {
  const registry = minecraftData("1.21.4");
  return Object.assign(new EventEmitter(), {
    registry,
    health,
    blockAt: () => null,
    world: { raycast: () => null },
    entity: { id: 0, position: new Vec3(0, 64, 0) },
    entities: Object.fromEntries(targets.map((target) => [target.id, target])),
    inventory: Object.assign(new EventEmitter(), {
      emptySlotCount: () => 36,
      count: (itemId: number) => (itemId === registry.itemsByName.white_wool.id ? inventory.count : 0),
      items: () => [],
      slots: new Array(46).fill(null),
    }),
    nearestEntity: (predicate: (entity: Entity) => boolean) => targets.find(predicate) ?? null,
  }) as unknown as Bot;
}

/**
 * A pursuit that reaches every matching loaded mob in turn, nearest first.
 *
 * The walk itself is the hunt process's own subject, tested against a fake
 * route in `hunt-process.test.ts`. What these tests ask is what the action
 * makes of each thing the pursuit can report, so this stands in for the walk
 * and for nothing else.
 */
function pursueLoaded(bot: Bot): HuntMobDependencies["pursue"] {
  return async (pursuit) => {
    const retired = new Set<number>();
    // The real process's rule: an unreachable fight is a stop on that target,
    // and a second stop gives it up.
    type Sighting = {
      readonly id: number;
      readonly position: { x: number; y: number; z: number };
      readonly distance: number;
    };
    const stops = new Map<number, number>();
    let lastStop: { readonly target: Sighting; readonly reason: string } | null = null;
    let previous: HuntTarget | null = null;
    let selectionReason = "Initial target selection.";
    const describe = (reason: string, target: Sighting) =>
      `${reason}; the target was last observed at ` +
      `${target.position.x},${target.position.y},${target.position.z}, ${target.distance.toFixed(1)} blocks away`;
    while (!pursuit.isSatisfied()) {
      const targets = Object.values(bot.entities)
        .filter((entity) => !retired.has(entity.id) && pursuit.matches(entity))
        .map((entity) => ({
          id: entity.id,
          position: {
            x: Math.floor(entity.position.x),
            y: Math.floor(entity.position.y),
            z: Math.floor(entity.position.z),
          },
          distance: entity.position.distanceTo(bot.entity.position),
        }))
        .sort((left, right) => left.distance - right.distance);
      await pursuit.onTargets?.(targets);
      const target = targets[0];
      if (!target) {
        return lastStop
          ? { status: "unreachable", reason: describe(lastStop.reason, lastStop.target) }
          : { status: "no_targets", reason: null };
      }
      if (previous?.id !== target.id)
        pursuit.onTargetChanged?.({ previous, selected: target, reason: selectionReason });
      previous = target;
      const refused = pursuit.preflight?.(bot.entities[target.id]!);
      if (refused) return { status: "capability_blocked", reason: describe(refused, target) };
      const engagement = await pursuit.engage(target.id);
      if (engagement.kind === "stopped") return { status: "stopped", reason: describe(engagement.reason, target) };
      if (engagement.kind === "unreachable") {
        const count = (stops.get(target.id) ?? 0) + 1;
        stops.set(target.id, count);
        lastStop = { target, reason: engagement.reason };
        selectionReason = engagement.reason;
        if (count >= 2) retired.add(target.id);
        continue;
      }
      retired.add(target.id);
      selectionReason =
        engagement.kind === "defeated" ? "The previous engagement was completed." : "The previous target was lost.";
    }
    return { status: "satisfied", reason: null };
  };
}

function outcome(kind: CombatOutcome["kind"], attacks: number, extra: Partial<CombatOutcome> = {}): CombatOutcome {
  return {
    kind,
    targetId: 0,
    attacks,
    stylesUsed: ["melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    observation: "",
    ...extra,
  } as CombatOutcome;
}

function died(attacks: number, x: number): TargetEngagement {
  return { outcome: outcome("died", attacks), deathPosition: { x, y: 64, z: 0 } };
}

test("quota attainment waits for handoff and cannot report success when withdrawal is unsafe", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const effects = dependencies(bot, inventory, []);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = false;
  const pending = huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...effects,
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        await waiting;
        return {
          observedAt: 1,
          kind: "unsafe",
          reason: "No withdrawal route or closed shelter was observed.",
          position: { x: 0, y: 64, z: 0 },
        };
      },
    },
  ).then((result) => {
    returned = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  release!();
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.termination, "quantity_collected");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.handoff.kind, "unsafe");
  assert.match(result.error ?? "", /HUNT_UNSAFE_HANDOFF/);
});

test("a completed quantity is checked again after handoff consumes it", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const result = await huntMob(
    bot,
    { mobName: "sheep", dropName: "white_wool", count: 1, campSpawner: false, allowWithoutShield: false, observeForMs: 0 },
    {},
    {
      ...dependencies(bot, inventory, []),
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        inventory.count = 0;
        return fakeCombat.finish(new AbortController().signal);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.termination, "inventory_changed");
  assert.equal(result.hunt.gained, 0);
});

for (const gainedDuringReflex of [false, true])
  test(`quarry observation retains its deadline and baseline through a reflex (gain: ${gainedDuringReflex})`, async () => {
    const inventory = { count: 4 };
    const bot = huntBot([], inventory);
    const budgets = new Budgets();
    const action = createCollectMobDropAction(
      bot,
      fakeNavigation,
      fakeCombat,
      createDiscardedItems(),
      dependencies(bot, inventory, []),
      budgets,
    );
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 300 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const original = runner.request();
    assert.equal(budgets.snapshot()[0]?.name, "quarry_observation");
    const claim = runner.claim("hunger_reflex", "Eating while awaiting quarry", async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (gainedDuringReflex) inventory.count++;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await pending;
    assert.equal(output.request?.id, original?.id);
    assert.ok("hunt" in output.result);
    if (!("hunt" in output.result)) return;
    assert.equal(output.result.hunt.inventoryBefore, 4);
    assert.equal(output.result.termination, gainedDuringReflex ? "quantity_collected" : "observation_exhausted");
    assert.deepEqual(budgets.snapshot(), []);
    assert.equal(bot.listenerCount("entitySpawn"), 0);
  });

function dependencies(
  bot: Bot,
  inventory: { count: number },
  engagements: readonly TargetEngagement[],
  swept = 0,
): HuntMobDependencies {
  let engagementIndex = 0;
  return {
    createCamp: () => {
      throw new Error("Unexpected camping");
    },
    finish: fakeCombat.finish,
    pursue: pursueLoaded(bot),
    engageTarget: async () => {
      const result = engagements[engagementIndex];
      engagementIndex += 1;
      assert.ok(result);
      return result;
    },
    collectDropAfterDeath: async () => {
      inventory.count += 1;
      return { kind: "collected" };
    },
    sweepDropsAfterDeath: async () => swept,
    gatherLoadedDrops: async () => 0,
    shieldPermitted: () => true,
  };
}

const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;
const fakeCombat: CombatController = {
  resourceRefusal: () => null,
  policy: new SurvivalPolicyState({} as Bot),
  engage: async () => outcome("target_lost", 0),
  stop: async () => undefined,
  runEnd: async () => {
    throw new Error("Unexpected End combat");
  },
  endDanger: () => false,
  activePosition: () => null,
  execution: () => null,
  onDecision: () => () => {},
  finish: async () => ({
    observedAt: 1,
    kind: "safe" as const,
    basis: "clear" as const,
    position: { x: 0, y: 64, z: 0 },
  }),
  canRecover: () => false,
  activeEngagement: () => null,
};

for (const { reflexGain, dropName } of [
  { reflexGain: 0, dropName: "white_wool" },
  { reflexGain: 1, dropName: "white_wool" },
  { reflexGain: 0, dropName: "arrow" },
  { reflexGain: 1, dropName: "arrow" },
]) {
  test(`a resumed ${dropName} hunt counts prior drops and ${reflexGain} drops gained during the reflex`, async () => {
    const inventory = { count: 0 };
    const bot = huntBot([], inventory);
    bot.inventory.count = (id) => id === bot.registry.itemsByName[dropName].id ? inventory.count : 0;
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let runs = 0;
    let entered!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pursue: HuntMobDependencies["pursue"] = async (pursuit) => {
      assert.equal(combat.policy.combat.bow, dropName !== "arrow");
      runs += 1;
      if (runs === 1) {
        inventory.count += 1;
        entered();
        await new Promise<void>((resolve) =>
          pursuit.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "stopped", reason: "reflex" };
      }
      while (!pursuit.isSatisfied()) inventory.count += 1;
      return { status: "satisfied", reason: null };
    };
    const action = createCollectMobDropAction(bot, fakeNavigation, combat, createDiscardedItems(), {
      ...dependencies(bot, inventory, []),
      pursue,
    });
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      {
        mob_name: dropName === "arrow" ? "skeleton" : "sheep",
        drop_name: dropName,
        count: 2,
        // The subject here is the arrow hunt's bow reserve, not the shield gate
        // a shieldless skeleton hunt would otherwise be refused by.
        allow_without_shield: true,
      },
    );
    await firstRun;
    const claim = runner.claim("hunger_reflex", "ate bread", async () => {
      assert.equal(combat.policy.snapshot().effective.combat.bow, dropName !== "arrow");
      inventory.count += reflexGain;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await pending;
    assert.equal(output.result.status, "succeeded");
    assert.equal(inventory.count, 2, "a count of two must not become three after one drop and a resumption");
    if (!("hunt" in output.result)) throw new Error("expected hunt evidence");
    assert.equal(output.result.hunt.inventoryBefore, 0);
    assert.equal(output.result.hunt.gained, 2);
    assert.equal(formatHuntMobResult(output.result).includes("Bow policy:"), dropName === "arrow");
    assert.equal(combat.policy.combat.bow, true, "request settlement releases the arrow reservation");
    assert.deepEqual(combat.policy.snapshot().overrides, [], "the hunt does not replace model policy");
  });
}

test("a terminal reflex interruption returns the hunt's uncollected drop sightings", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = createCollectMobDropAction(bot, fakeNavigation, fakeCombat, createDiscardedItems(), {
    ...dependencies(bot, inventory, []),
    pursue: async (pursuit) => {
      const entity = {
        id: 99,
        isValid: true,
        position: new Vec3(8, 63, 2),
        getDroppedItem: () => ({ name: "white_wool", count: 2 }),
      } as Entity;
      bot.entities[entity.id] = entity;
      bot.emit("itemDrop", entity);
      entered();
      await new Promise<void>((_resolve, reject) =>
        pursuit.signal!.addEventListener("abort", () => reject(pursuit.signal!.reason), { once: true }),
      );
      throw new Error("unreachable");
    },
  });
  const runner = new ActionRunner();
  const pending = runner.run(
    { ...action, execution: { kind: "resumable_task" } },
    { mob_name: "sheep", drop_name: "white_wool", count: 2 },
  );
  await ready;
  const claim = runner.claim("hostile_reflex", "withdrew from contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: null },
  }));
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  if (!("hunt" in output.result)) throw new Error("expected hunt evidence after interruption");
  assert.equal(output.result.status, "failed");
  assert.equal(output.result.hunt.gained, 0);
  assert.equal(output.result.hunt.drops[0]?.observedCount, 2);
  assert.equal(output.result.hunt.drops[0]?.collectedByBot, false);
  assert.equal(output.result.hunt.drops[0]?.state, "loaded");
  assert.equal(bot.listenerCount("itemDrop"), 0);
});

test("normalizes exact registry names and defaults to one requested drop", () => {
  assert.deepEqual(parseHuntMobRequest({ mob_name: "Minecraft:Sheep", drop_name: "White Wool" }), {
    campSpawner: false,
    allowWithoutShield: false,
    observeForMs: 0,
    mobName: "sheep",
    dropName: "white_wool",
    count: 1,
  });
});

test("hunts loaded targets until the requested inventory gain is observed", async () => {
  const inventory = { count: 4 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 2 },
    {},
    dependencies(bot, inventory, [died(4, 3), died(5, 5)], 1),
  );

  assert.deepEqual(result, {
    status: "succeeded",
    termination: "quantity_collected",
    handoff: { observedAt: 1, kind: "safe", basis: "clear", position: { x: 0, y: 64, z: 0 } },
    hunt: {
      mob: "sheep",
      drop: "white_wool",
      requested: 2,
      gained: 2,
      inventoryBefore: 4,
      inventoryAfter: 6,
      targetsEngaged: 2,
      retargets: 1,
      targetChanges: [
        {
          fromTargetId: 7,
          toTargetId: 8,
          position: { x: 5, y: 64, z: 0 },
          distance: 5,
          reason: "The previous engagement was completed.",
        },
      ],
      targetDeathsObserved: 2,
      attacks: 9,
      combatStyles: ["melee"],
      projectileGuards: 0,
      otherDropsCollected: 2,
      drops: [],
      targets: [
        { species: "sheep", id: 7, x: 3, y: 64, z: 0, distance: 3 },
        { species: "sheep", id: 8, x: 5, y: 64, z: 0, distance: 5 },
      ],
    },
  });
  assert.match(formatHuntMobResult(result), /white_wool 2\/2/);
  assert.match(formatHuntMobResult(result), /Loaded sheep at return: #7 at 3,64,0 \(3 blocks\); #8 at 5,64,0/);
});

for (const missed of ["item_gone", "not_collected"] as const)
test(`a ${missed} drop retires its kill and the hunt continues to the next loaded target`, async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  let pickups = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3), died(2, 5)]),
      collectDropAfterDeath: async () => {
        if (++pickups === 1) return missed === "item_gone" ? { kind: "item_gone" } :
          { kind: "not_collected", route: { status: "stopped", reason: "Placement cell occupied by Enderman", elapsedMs: 10 } };
        inventory.count++;
        return { kind: "collected" };
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 2);
  assert.equal(pickups, 2);
});

test("fails truthfully when no matching mob is loaded", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /HUNT_TARGET_NOT_LOADED/);
  assert.equal(result.hunt.targetsEngaged, 0);
  assert.equal(result.hunt.gained, 0);
  assert.deepEqual(result.hunt.targets, []);
});

test("moves on to the next loaded target when one disappears without a death event", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const lost = mob(7, registry.entitiesByName.sheep.id, "sheep", 3);
  const next = mob(8, registry.entitiesByName.sheep.id, "sheep", 6);
  const bot = huntBot([lost, next], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, [{ outcome: outcome("target_lost", 2), deathPosition: null }, died(3, 6)]),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.targetsEngaged, 2);
  assert.equal(result.hunt.attacks, 5);
  assert.equal(result.hunt.targetDeathsObserved, 1);
});

test("gathers requested drops already on the ground before hunting", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.sheep.id, "sheep", 3);
  const bot = huntBot([target], inventory);
  let engaged = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      gatherLoadedDrops: async () => {
        inventory.count += 1;
        return 1;
      },
      engageTarget: async () => {
        engaged += 1;
        return died(1, 3);
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(engaged, 0);
});

test("gathers an observed requested item beyond the old eight-block cutoff", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  bot.entities[9] = {
    id: 9,
    isValid: true,
    position: new Vec3(20, 60, 0),
    getDroppedItem: () => ({ name: "white_wool", count: 1 }),
  } as Entity;
  const navigate: NavigationRuntime["navigate"] = async () => {
    inventory.count++;
    return { status: "completed", elapsedMs: 0 };
  };
  const gathered = await gatherLoadedDrops(
    bot,
    { navigate } as NavigationRuntime,
    { name: "white_wool", id: bot.registry.itemsByName.white_wool!.id },
    {},
    createDiscardedItems(),
  );
  assert.equal(gathered, 1);
  assert.equal(inventory.count, 1);
});

test("an incidental kill's drop can complete a hunt even when the selected target disappears", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([mob(7, minecraftData("1.21.4").entitiesByName.sheep.id, "sheep", 3)], inventory);
  let fought = false;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      engageTarget: async () => {
        fought = true;
        return { outcome: outcome("target_lost", 2), deathPosition: null };
      },
      gatherLoadedDrops: async () => {
        if (fought) inventory.count = 1;
        return fought ? 1 : 0;
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 0, "pickup does not invent a death verdict on the selected mob");
});

test("reports the controller's verdict when a fight ends without a kill", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.blaze.id, "blaze", 9, "Hostile mobs");
  const bot = huntBot([target], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: true, observeForMs: 0, mobName: "blaze", dropName: "white_wool", count: 1 },
    {},
    // An unreachable fight is a stop on that target, not on the hunt: the one
    // loaded blaze is tried twice before the hunt gives it up.
    dependencies(bot, inventory, [
      {
        outcome: outcome("unreachable", 0, { observation: "Combat approach stopped: no route.", projectileGuards: 2 }),
        deathPosition: null,
      },
      {
        outcome: outcome("unreachable", 0, { observation: "Combat approach stopped: no route.", projectileGuards: 2 }),
        deathPosition: null,
      },
    ]),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /HUNT_APPROACH_STOPPED.*no route.*last observed at/);
  assert.equal(result.hunt.projectileGuards, 4);
});

test("a pursuit that never reached the mob says where it was and how far", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.rabbit.id, "rabbit", 65)], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "rabbit", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      pursue: async (pursuit) => {
        await pursuit.onTargets?.([{ id: 7, position: { x: 65, y: 64, z: 0 }, distance: 65 }]);
        return {
          status: "unreachable",
          reason: "no path; closest node was 30,64,0; the target was last observed at 65,64,0, 65.0 blocks away",
        };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /^\[HUNT_APPROACH_STOPPED\]/);
  assert.match(result.error, /last observed at 65,64,0, 65\.0 blocks away/);
  assert.deepEqual(result.hunt.targets, [{ species: "rabbit", id: 7, x: 65, y: 64, z: 0, distance: 65 }]);
});

test("a wounded hunt delegates recovery to the engagement instead of refusing the quantity request", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.blaze.id, "blaze", 9, "Hostile mobs");
  const bot = huntBot([target], inventory, 6);
  let engaged = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: true, observeForMs: 0, mobName: "blaze", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      engageTarget: async () => {
        engaged += 1;
        return died(1, 9);
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(engaged, 1);
});

test("rejects unknown registry facts before selecting a target", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const unknownMob = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "imaginary_beast", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );
  const unknownDrop = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "imaginary_drop", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );

  assert.equal(unknownMob.status, "failed");
  assert.match(unknownMob.error, /UNKNOWN_HUNT_MOB/);
  assert.equal(unknownDrop.status, "failed");
  assert.match(unknownDrop.error, /UNKNOWN_HUNT_DROP/);
});

for (const priorGain of [0, 1]) {
  test(`missing defensive build material ends the hunt with ${priorGain} prior drops, without trying another target`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.sheep.id;
    const bot = huntBot([mob(7, type, "sheep", 3), mob(8, type, "sheep", 5), mob(9, type, "sheep", 6)], inventory);
    const seen: number[] = [];
    const missing = "[COMBAT_BUILD_MATERIALS_MISSING] No usable building blocks remain for defensive construction.";
    const result = await huntMob(
      bot,
      { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 2 },
      {},
      {
        ...dependencies(bot, inventory, []),
        engageTarget: async (target) => {
          seen.push(target.id);
          return priorGain && target.id === 7
            ? died(2, 3)
            : {
                outcome: outcome("capability_blocked", 0, { reason: "building_materials", observation: missing }),
                deathPosition: null,
              };
        },
      },
    );
    assert.equal(result.status, priorGain ? "partial" : "failed");
    assert.match(result.error ?? "", /COMBAT_BUILD_MATERIALS_MISSING/);
    assert.deepEqual(seen, priorGain ? [7, 8] : [7]);
    assert.equal(result.hunt.gained, priorGain);
    assert.equal(result.hunt.retargets, priorGain);
  });
}

test("real pursuit reports selected target changes and the refusal that caused them", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.sheep.id;
  const bot = huntBot([mob(7, type, "sheep", 3), mob(8, type, "sheep", 5)], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      pursue: (pursuit) =>
        hunt(bot, {
          ...pursuit,
          movements: {} as never,
          route: async () => {
            throw new Error("already in contact");
          },
        }),
      engageTarget: async (target) =>
        target.id === 7
          ? {
              outcome: outcome("unreachable", 0, { observation: "The target's roof opening is obstructed." }),
              deathPosition: null,
            }
          : died(2, 5),
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.retargets, 1);
  assert.equal(result.hunt.targetChanges[0]?.fromTargetId, 7);
  assert.equal(result.hunt.targetChanges[0]?.toTargetId, 8);
  assert.match(result.hunt.targetChanges[0]?.reason ?? "", /roof opening is obstructed/);
  assert.match(formatHuntMobResult(result), /retargets: 1/);
});

test("publishes the action as an intentional destructive task", () => {
  const action = createCollectMobDropAction(
    huntBot([], { count: 0 }),
    fakeNavigation,
    fakeCombat,
    createDiscardedItems(),
  );
  assert.equal(action.name, "collect_mob_drop");
  assert.equal(action.execution.kind, "resumable_task");
  assert.equal(action.annotations?.destructiveHint, true);
  assert.equal(action.annotations?.readOnlyHint, false);
});

// The shield gate. The refusal's whole value is that it lands before the bot
// walks up to the thing, so the first test counts pursuits as well as reading
// the verdict; a stop reported after the approach would be a later, lesser fact.

/** A shield loose in the inventory, which is what the loadout equips from. */
function carryingShield(bot: Bot): Bot {
  const shield = { name: "shield" } as unknown as ReturnType<Bot["inventory"]["items"]>[number];
  bot.inventory.items = () => [shield];
  return bot;
}

function huntRequest(mobName: string, allowWithoutShield = false): HuntMobRequest {
  return { campSpawner: false, allowWithoutShield, observeForMs: 0, mobName, dropName: "white_wool", count: 1 };
}

/** A skeleton by `kind`, a hoglin only by the registry category its `type` contradicts. */
for (const mobName of ["skeleton", "hoglin"])
  test(`a shieldless ${mobName} hunt is refused before the pursuit takes a step`, async () => {
    const inventory = { count: 0 };
    const registry = minecraftData("1.21.4");
    const bot = huntBot([mob(7, registry.entitiesByName[mobName]!.id, mobName, 3, "Hostile mobs")], inventory);
    let pursued = 0;
    const result = await huntMob(bot, huntRequest(mobName), {}, {
      ...dependencies(bot, inventory, []),
      pursue: async (pursuit) => {
        pursued += 1;
        return pursueLoaded(bot)(pursuit);
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.termination, "shield_required");
    assert.match(result.error, /HUNT_NO_SHIELD/);
    assert.match(result.error, /allow_without_shield: true/, "the refusal names the parameter that overrides it");
    assert.equal(pursued, 0, "the refusal precedes the approach");
    assert.equal(result.hunt.targetsEngaged, 0);
  });

test("a carried shield the policy forbids is refused on the same terms as no shield at all", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    shieldPermitted: () => false,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.termination, "shield_required");
  assert.match(result.error, /HUNT_NO_SHIELD/);
  assert.match(result.error, /set_survival_policy/, "a forbidden shield names the policy that forbade it");
});

test("a carried, permitted shield admits the hostile hunt without the override", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("allow_without_shield admits the hunt a missing shield would have refused", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory);
  const result = await huntMob(bot, huntRequest("skeleton", true), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("passive quarry is never asked for a shield", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.chicken.id, "chicken", 3)], inventory);
  const result = await huntMob(bot, huntRequest("chicken"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("a shield lost mid-hunt refuses the next leg rather than the drop already collected", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const type = registry.entitiesByName.skeleton.id;
  const bot = carryingShield(huntBot([mob(7, type, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(
    bot,
    { ...huntRequest("skeleton"), count: 2, observeForMs: 5_000 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3)]),
      // The shield breaks on the kill, and a second skeleton wanders in during
      // the observation window, so the next leg re-enters the gate carrying
      // nothing to block with.
      collectDropAfterDeath: async () => {
        inventory.count += 1;
        bot.inventory.items = () => [];
        setTimeout(() => {
          bot.entities[8] = mob(8, type, "skeleton", 5, "Hostile mobs");
          bot.emit("entitySpawn", bot.entities[8]!);
        }, 0);
        return { kind: "collected" };
      },
    },
  );

  assert.equal(result.termination, "shield_required");
  assert.equal(result.status, "partial", "the drop already collected is not erased by the refusal");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 1, "the leg fought while shielded still happened");
});

for (const loss of ["broken", "forbidden"] as const) {
  test(`a ${loss} shield stops the real pursuit before approaching the next loaded enemy`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
    const bot = carryingShield(huntBot([
      mob(7, type, "skeleton", 3, "Hostile mobs"),
      mob(8, type, "skeleton", 20, "Hostile mobs"),
    ], inventory));
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let approached = 0;
    let permitted = true;
    const navigation = {
      ...fakeNavigation,
      navigate: async () => {
        approached++;
        throw new Error("The unshielded hunt must stop before approaching the second enemy");
      },
    } as NavigationRuntime;
    const result = await huntMob(bot, { ...huntRequest("skeleton"), count: 2 }, {}, {
      ...dependencies(bot, inventory, [died(2, 3)]),
      pursue: huntMobDependencies(bot, navigation, combat).pursue,
      shieldPermitted: () => permitted,
      collectDropAfterDeath: async () => {
        inventory.count++;
        if (loss === "broken") bot.inventory.items = () => [];
        else permitted = false;
        return { kind: "collected" };
      },
    });

    assert.equal(approached, 0);
    assert.equal(result.termination, "shield_required");
    assert.equal(result.status, "partial");
    assert.match(result.error ?? "", /HUNT_NO_SHIELD/);
    assert.equal(result.hunt.gained, 1);
    assert.equal(result.hunt.targetDeathsObserved, 1);
    assert.equal(result.hunt.targetsEngaged, 1);
  });
}

test("a shield lost while gathering drops at contact is checked again before engaging", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = carryingShield(huntBot([mob(7, type, "skeleton", 3, "Hostile mobs")], inventory));
  let pickups = 0;
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    gatherLoadedDrops: async () => {
      if (++pickups === 2) bot.inventory.items = () => [];
      return 0;
    },
  });
  assert.equal(result.termination, "shield_required");
  assert.equal(result.hunt.targetsEngaged, 0);
});

test("the default request does not opt out of the shield gate", () => {
  assert.equal(parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone" }).allowWithoutShield, false);
  assert.equal(
    parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone", allow_without_shield: true }).allowWithoutShield,
    true,
  );
});

test("evidence lists quarry as loaded at return, not as the pursuit once scanned it", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  const base = dependencies(bot, inventory, [died(4, 3)], 1);
  const effects: HuntMobDependencies = {
    ...base,
    engageTarget: async (...args: Parameters<HuntMobDependencies["engageTarget"]>) => {
      const engagement = await base.engageTarget(...args);
      // The kill unloads its victim and the survivor wanders before the report is written.
      delete bot.entities[7];
      bot.entities[8]!.position = new Vec3(9, 64, 0);
      return engagement;
    },
  };
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    effects,
  );
  assert.deepEqual(result.hunt.targets, [{ species: "sheep", id: 8, x: 9, y: 64, z: 0, distance: 9 }]);
  assert.match(formatHuntMobResult(result), /Loaded sheep at return: #8 at 9,64,0 \(9 blocks\)/);
});

test("the report rounds leftover drop positions and counts quarry beyond the nearest sixteen", () => {
  const targets = Array.from({ length: 20 }, (_, index) => ({
    species: "sheep",
    id: 100 + index,
    x: index + 1,
    y: 64,
    z: 0,
    distance: index + 1,
  }));
  const result: Parameters<typeof formatHuntMobResult>[0] = {
    status: "failed",
    termination: "no_loaded_targets",
    error: "none left",
    handoff: { observedAt: 1, kind: "safe", basis: "clear", position: { x: 0, y: 64, z: 0 } },
    hunt: {
      mob: "sheep",
      drop: "white_wool",
      requested: 1,
      gained: 0,
      inventoryBefore: 0,
      inventoryAfter: 0,
      targetsEngaged: 0,
      retargets: 0,
      targetChanges: [],
      targetDeathsObserved: 0,
      attacks: 0,
      combatStyles: [],
      projectileGuards: 0,
      otherDropsCollected: 0,
      drops: [
        {
          id: 24769,
          item: "bone",
          observedCount: 2,
          position: { x: 859.875, y: 84, z: 213.96969811989464 },
          blocks: { atPosition: "air", belowPosition: "air" },
          observedAt: "2026-09-14T13:35:24.184Z",
          firstSeen: "during_hunt",
          state: "loaded",
          collectedByBot: false,
          collectedByOther: false,
        },
      ],
      targets,
    },
  };
  const text = formatHuntMobResult(result);
  assert.match(text, /#24769 bone ×2 at 859.9,84,214 \(in air, above air; last seen 2026-09-14T13:35:24.184Z\)/);
  assert.match(text, /#115 at 16,64,0 \(16 blocks\); \+4 more farther away/);
  assert.doesNotMatch(text, /#116 at/);
});
