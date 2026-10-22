/**
 * Fixtures shared by the combat controller's test files: a scripted bot and
 * target, a refusing navigation runtime, and the arenas the cover and roof
 * tests plan against. Like `*.test.ts`, this file is left out of the build.
 */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { botFixture, registry } from "../../../test-support/bot.js";
import { createTestCombatController as createCombatController } from "../../../test-support/combat.js";
import { observation } from "../../../test-support/navigation.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { CombatPerception, positionThreat } from "../../perception/combat/observations.js";
import type { PolicyChanges } from "../../policy/contract.js";
import { positionWorld } from "../../positioning/combat/geometry.js";
import { findCombatPosition } from "../../positioning/combat/planner.js";
import type { SurvivalPolicyState } from "../../state/survival-policy.js";

const goalTestWorld = new MemoryWorld();
const fixtureClocks = new Set<() => void>();

/** Stops every combat fixture's physics clock; register it with `afterEach`. */
export function stopCombatFixtureClocks() {
  for (const stop of fixtureClocks) stop();
  fixtureClocks.clear();
}

/** A session-lifetime edit of the controller's live survival policy. */
export function editPolicy(controller: { policy: SurvivalPolicyState }, changes: PolicyChanges, reason = "test") {
  return controller.policy.edit({
    operation: "set",
    expected_revision: controller.policy.snapshot().revision,
    changes,
    lifetime: { kind: "session" },
    reason,
  });
}

export type CombatScript = {
  /** Runs once per fixture physics tick, after the clock advances and before listeners see the tick. */
  onWait?: () => void;
  onAttack?: () => void;
  onShot?: () => void;
};

/** A Mineflayer entity as the fixtures build it. */
export type Entity = Parameters<Bot["attack"]>[0];

/** These defense fixtures use target #7; a real bot-directed hit authorizes
 * their guard. Anger metadata alone also covers Endermen fighting the dragon. */
export function controllerAfterObservedHit(bot: Bot, navigation: NavigationRuntime) {
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

/** Loads a stone floor at y=63 with air above it through `top`, `radius` blocks around the origin. */
export function openArena(world: MemoryWorld, radius = 12, top = 72): MemoryWorld {
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++)
      for (let y = 63; y <= top; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  return world;
}

/**
 * A still, healthy, player-sized bot in an open arena with a blaze `targetZ`
 * blocks along z, and the planner's cover against it: already standing
 * unless `built` is false. The bot's world reads the same arena.
 */
export function blazeCoverArena(fixture: ReturnType<typeof combatFixture>, targetZ: number, built = true) {
  const { bot, target } = fixture;
  bot.entity.position.set(0.5, 64, 0.5);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.entity.onGround = true;
  bot.entity.velocity = new Vec3(0, 0, 0);
  bot.health = 20;
  bot.food = 20;
  target.name = "blaze";
  target.position.set(0.5, 64, targetZ);
  target.metadata = [];
  const world = openArena(new MemoryWorld());
  const threat = positionThreat(bot, target);
  const plan = findCombatPosition(world, bot.entity.position.floored(), [threat], threat, 64)!;
  assert.ok(plan, "the open arena has a cover position against the blaze");
  if (built) for (const cell of plan.placements) world.load(cell, { stateId: 1 });
  Object.defineProperty(bot, "world", { value: positionWorld(world) });
  return { world, plan };
}

/** Which of the cover plan's three supported cells a navigation request's goal accepts, if any. */
export function plannedCoverCell(
  options: Parameters<NavigationRuntime["navigate"]>[0],
  plan: ReturnType<typeof blazeCoverArena>["plan"],
) {
  const goal = options.goal.resolve(observation());
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("invalid test goal");
  return [plan.protected, plan.corner, plan.fighting].find((feet) =>
    goal.isSatisfied({ feet, remainingScaffolds: 0, overlayId: "0" }, goalTestWorld),
  );
}

/** The fixture's carried stack of `name`; combat fixtures list each item once. */
export function stack(bot: Bot, name: string) {
  return bot.inventory.items().find((item) => item.name === name)!;
}

/**
 * A player-sized bot at the origin of an open arena, facing a hostile blaze
 * eight blocks along -z, with a navigation fixture that reads the same arena.
 */
export function blazePreflightFixture(items: readonly string[]) {
  const fixture = combatFixture(items);
  fixture.bot.entity.position.set(0.5, 64, 0.5);
  fixture.bot.entity.width = 0.6;
  fixture.bot.entity.height = 1.8;
  fixture.target.name = "blaze";
  fixture.target.kind = "Hostile mobs";
  fixture.target.position.set(0.5, 64, -8);
  const world = openArena(new MemoryWorld());
  const navigation = { ...navigationFixture(), world };
  return { ...fixture, world, navigation };
}

/** The server's "creepy" metadata flag: an Enderman that is angry at someone. */
export function setEndermanAnger(bot: Bot, enderman: Entity, angry: boolean) {
  Reflect.set(enderman.metadata, bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"), angry);
}

/** A navigation runtime over a 13x13 stone floor at y=63 that refuses to route. */
export function navigationFixture(): NavigationRuntime {
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

/** A bow target: holds a bow, and `drawing` drives the server's hand-state flag. */
export function armWithBow(target: Entity): { drawing: (active: boolean) => void } {
  const metadata: unknown[] = [];
  metadata[8] = 0;
  target.metadata = metadata as Entity["metadata"];
  Object.defineProperty(target, "heldItem", { value: { name: "bow", type: 1 } });
  return { drawing: (active) => (metadata[8] = active ? 0x01 : 0) };
}

/**
 * A scripted bot fighting target #7 (a zombie `targetDistance` blocks along +x)
 * with a full stack of each of `items`. It records every equipment, item-use,
 * control and attack effect, and its physics clock advances one tick per
 * macrotask while anything listens for `physicsTick`. Test files stop the clocks
 * with `afterEach(stopCombatFixtureClocks)`.
 */
export function combatFixture(
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
  const target = {
    id: 7,
    name: "zombie",
    isValid: true,
    height: 1.95,
    width: 0.6,
    position: new Vec3(options.targetDistance ?? 2, 64, 0),
  } as Entity;
  const slots: Record<number, { name: string } | null> = {};
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

  // The shared double with this fixture's recorders as overrides. The entity
  // keeps the bare id, yaw and position these tests were written against: a
  // test that needs a body size or footing sets it, as blazeCoverArena does.
  const bot: Bot = botFixture(
    {
      // A full stack of each: one bow or shield, but enough blocks to build a
      // cover and enough arrows that no test runs out by accident.
      items: items.map((name, type) => ({ name, type, count: registry.itemsByName[name]?.stackSize ?? 1 })),
      slots,
      blocks: () => null,
      entities: { [target.id]: target },
    },
    {
      _client: new EventEmitter(),
      entity: { id: 2, yaw: 0, position: new Vec3(0, 64, 0) },
      world: { raycast: () => null },
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
      waitForTicks: (ticks: number) => waitForPhysicsTicks(bot, ticks, new AbortController().signal),
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
    },
  );
  Object.defineProperty(bot, "heldItem", { get: () => heldItem });
  // Physics is independent of the controller's wait API, as it is on a server.
  // A new listener starts the fixture clock; the test owns its final cleanup.
  let scheduled: ReturnType<typeof setImmediate> | null = null;
  let stopped = false;
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (stopped || bot.listenerCount("physicsTick") === 0) return;
      clock.tick++;
      script.onWait?.();
      bot.emit("physicsTick");
      schedule();
    });
  };
  (bot as unknown as EventEmitter).on("newListener", (event) => {
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
