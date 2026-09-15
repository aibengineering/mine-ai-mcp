/**
 * A run whose body is held under a ceiling it does not fit beneath.
 *
 * The fake bot fails every movement while the leaf is over it, as the live
 * body did under a reset big dripleaf, and completes movements once the leaf
 * is gone. What the run does in between is the subject.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import type { EffectHandle } from "../bot.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import type { MemoryWorld } from "../world/memory-world.js";
import type { NavigationEvent } from "../telemetry/index.js";
import { createNavigator } from "./navigator.js";

/** A big dripleaf's flat leaf over the start cell: a slab from 0.6875 to 0.9375, above a crouch and below a stand. */
const LEAF = { x: 0, y: 64, z: 0 };
const LEAF_SHAPE = [{ minX: 0, minY: 0.6875, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }];

class HeldBot extends FakeNavigationBot {
  readonly breaks: PlannedOperation[] = [];
  constructor(private readonly world: MemoryWorld) {
    super();
    this.current = observation(0, 63, 0);
  }
  #held() {
    const leaf = this.world.blockAt(LEAF.x, LEAF.y, LEAF.z);
    return leaf.kind === "loaded" && leaf.collisionShapes.length > 0;
  }
  override async prepareMovement(step: PlannedStep) {
    if (this.#held()) return { kind: "failed", observation: "the body did not move" } as const;
    this.arrive(step.to);
    return { kind: "completed", arrival: step.to } as const;
  }
  override startEffect(operation: Exclude<PlannedOperation, { kind: "move" }>): EffectHandle {
    this.breaks.push(operation);
    if (operation.kind === "break") {
      this.world.load(operation.position, { stateId: 0 });
      // The live bot reads the world's revision; this fake's observation carries its own.
      this.current = { ...this.current, worldRevision: this.current.worldRevision + 1 };
    }
    return { issued: true, completion: Promise.resolve({ kind: "accepted" }), cancel: () => undefined };
  }
}

function heldWorld(safeToBreak = true) {
  const world = flatWorld();
  world.load(LEAF, { stateId: 7, collisionShapes: LEAF_SHAPE, traits: { empty: false, safeToBreak } });
  return world;
}

test("a held body breaks the ceiling once, then walks the route it could not start", async () => {
  const world = heldWorld();
  const bot = new HeldBot(world);
  const events: NavigationEvent[] = [];
  const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => events.push(event)) });
  const outcome = await settle(navigator, {
    goal: exactBlockGoal({ x: 2, y: 63, z: 0 }),
    policy: createMovementPolicy({ evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: 42, expectedTicks: 10 } }) }),
  });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.deepEqual(
    bot.breaks.map((operation) => (operation.kind === "break" ? operation.position : operation.kind)),
    [LEAF],
  );
  const pinned = events.filter((event) => event.kind === "pinned_body");
  assert.equal(pinned.length, 1);
  assert.deepEqual(pinned[0] && "cell" in pinned[0] ? { cell: pinned[0].cell, released: pinned[0].released } : null, {
    cell: LEAF,
    released: true,
  });
  assert.equal(bot.current.position.x, 2.5);
  assert.equal(bot.breaks[0]?.kind === "break" && bot.breaks[0].toolType, 42);
});

for (const [name, world, policy] of [
  ["may not dig", heldWorld(), createMovementPolicy({ allowDigging: false })],
  ["cannot break the block", heldWorld(false), createMovementPolicy()],
  ["protects the ceiling", heldWorld(), createMovementPolicy({ evaluateBreak: () => ({
    decision: { kind: "prohibited", reason: "protected cell" }, tool: { itemType: null, expectedTicks: 20 },
  }) })],
  ["would release liquid", heldWorld(), createMovementPolicy({ confirmBreak: () => ({
    kind: "prohibited", reason: "breaking this block would open the route into liquid", cause: "opens_into_liquid",
  }), priceBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: null, expectedTicks: 20 } }) })],
] as const) {
  test(`a held body that ${name} settles at once as pinned, naming the block`, async () => {
    const bot = new HeldBot(world);
    const events: NavigationEvent[] = [];
    const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => events.push(event)) });
    const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy });
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed" || outcome.failure.kind !== "no_progress") assert.fail(JSON.stringify(outcome));
    assert.equal(outcome.failure.reason, "pinned_body");
    assert.match(outcome.failure.observation, /held under 0,64,0/u);
    assert.equal(bot.breaks.length, 0);
    assert.equal(events.filter((event) => event.kind === "step_failed").length, 1, "one failure, no retry");
    assert.equal(events.some((event) => event.kind === "pinned_body" && !event.released), true);
  });
}

test("cancelling a pin release stops the effect and waits for its cleanup without another tick", async () => {
  const world = heldWorld();
  let started!: () => void;
  const issued = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  let cancellations = 0;
  class PendingBot extends HeldBot {
    override startEffect(): EffectHandle {
      started();
      return {
        issued: true,
        completion: new Promise((resolve) => { finish = () => resolve({ kind: "failed", observation: "cancelled" }); }),
        cancel: () => { cancellations++; },
      };
    }
  }
  const bot = new PendingBot(world);
  const navigator = createNavigator({ world, bot });
  const admission = navigator.startRun({ goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy() });
  assert.equal(admission.kind, "started");
  if (admission.kind !== "started") assert.fail("busy");
  await issued;
  admission.handle.cancel("stop the escape");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.notEqual(navigator.active, null, "physical cleanup still owns admission");
  finish();
  assert.equal((await admission.handle.outcome).kind, "stopped");
  assert.equal(navigator.active, null);
  assert.equal(bot.ticks.size, 0);
});

test("cancelling while a second ceiling still pins the body releases the observation wait", async () => {
  const world = heldWorld();
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 8, collisionShapes: LEAF_SHAPE, traits: { empty: false, safeToBreak: true } });
  const bot = new HeldBot(world);
  bot.current = { ...bot.current, position: { x: 0.9, y: 63, z: 0.5 } };
  const navigator = createNavigator({ world, bot });
  const admission = navigator.startRun({ goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy() });
  if (admission.kind !== "started") assert.fail("busy");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(bot.breaks.length, 1);
  assert.equal(bot.ticks.size, 1, "waiting for body clearance");
  admission.handle.cancel();
  assert.equal((await admission.handle.outcome).kind, "stopped");
  assert.equal(bot.ticks.size, 0);
});
