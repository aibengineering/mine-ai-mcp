/**
 * The route executor: one plan, its steps, their effects, and how it hands the
 * body from one movement to the next or gives it back on cancellation.
 *
 * Every test constructs a `RouteExecutor`. The Mineflayer actuator the
 * executor drives in production has its own tests in `../mineflayer/bot.test.ts`;
 * a test that builds a `MineflayerBot` belongs there, not here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeNavigationBot,
  STILL,
  flatWorld,
  gapStep,
  movementStep,
  observation,
  routePlan,
  stepUpStep,
} from "../../test-support/navigation.js";
import type { MovementPreparation } from "../bot.js";
import type { PlannedStep } from "../movements/movement.js";
import type { NavigationObservation, Position3 } from "../world/world.js";
import {
  createMovementController,
  type MovementControlIntent,
  type MovementExecution,
  type MovementSnapshot,
} from "./movement-controller.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { OpenedPassages } from "./opened-passages.js";
import { RouteExecutor, type RouteExecutionRequest } from "./route-executor.js";

/** Let the executor's pending microtasks and immediates run. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const walkStep = (id: string, fromX: number, toX: number) =>
  movementStep("walk", { x: fromX, y: 63, z: 0 }, { x: toX, y: 63, z: 0 }, { id, expectedTicks: 4 });

function routeExecutor(request: Omit<RouteExecutionRequest, "passages" | "effectConfirmed">): RouteExecutor {
  return new RouteExecutor({
    ...request,
    passages: new OpenedPassages(request.context.world, request.context.bot.observe().dimension),
    effectConfirmed: () => undefined,
  });
}

function executeSingleStep(options: {
  readonly step: PlannedStep;
  readonly world: ReturnType<typeof flatWorld>;
  readonly bot: FakeNavigationBot;
  readonly ledger?: ExpectedMutationLedger;
  readonly signal?: AbortSignal;
}) {
  return routeExecutor({
    context: {
      runId: "run",
      world: options.world,
      bot: options.bot,
      ledger: options.ledger ?? new ExpectedMutationLedger(),
      signal: options.signal ?? new AbortController().signal,
    },
    plan: routePlan([options.step]),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
}

/**
 * A fake bot that drives the real movement controllers, one injected physics
 * tick at a time, and counts what the executor asks of it.
 */
class TickDrivenBot extends FakeNavigationBot {
  subscriptions = 0;
  preparations = 0;
  controls = 0;
  snapshotCalls = 0;
  nextVelocity: Position3 = STILL;
  lastIntent: MovementControlIntent | null = null;
  readonly preparedVelocities: Position3[] = [];
  readonly executions: MovementExecution[] = [];
  readonly steeringTargets: Position3[] = [];
  override movementSnapshot() {
    this.snapshotCalls += 1;
    const velocity = this.nextVelocity;
    this.nextVelocity = STILL;
    return {
      position: this.current.position,
      velocity,
      onGround: this.current.stance === "supported",
      isInWater: false,
      climbing: false,
      yaw: 0,
    };
  }
  override get ownedControlCount() {
    return this.controls;
  }
  override clearOwnedControls() {
    this.controls = 0;
  }
  override async prepareMovement(
    step: PlannedStep,
    _token: unknown,
    _signal: AbortSignal,
    execution: MovementExecution,
    snapshot: () => MovementSnapshot,
  ): Promise<MovementPreparation> {
    this.preparations += 1;
    this.executions.push(execution);
    const start = snapshot();
    this.preparedVelocities.push(start.velocity);
    return { kind: "ready", controller: createMovementController(step, start, execution, 0.6) } as const;
  }
  override applyMovementControls(intent: MovementControlIntent) {
    this.lastIntent = intent;
    this.controls = Object.values(intent).filter(Boolean).length;
  }
  override applyMovementSteering(target: Position3) {
    this.steeringTargets.push(target);
  }
  override subscribePhysicsTick(listener: () => void) {
    this.subscriptions += 1;
    return super.subscribePhysicsTick(listener);
  }
  /** One physics tick with the body supported at `x`, carrying `velocity` into it. */
  tickAt(x: number, velocity: Position3 = STILL) {
    this.current = observation(x);
    this.nextVelocity = velocity;
    for (const tick of [...this.ticks]) tick();
  }
  /** One physics tick with the body thrown airborne to `(x, y)` at `velocity`, as a hit would. */
  knockback(x: number, y: number, velocity: Position3) {
    this.current = { ...observation(x, y), stance: "airborne" };
    this.nextVelocity = velocity;
    for (const tick of [...this.ticks]) tick();
  }
}

// ── Effects and their confirmation ───────────────────────────────────────────

/**
 * A break followed by a move. Each row is one stance the bot may be in when
 * the world confirms the break, and whether the executor must settle the body
 * before moving on: never for a downward step, whose fall is its own.
 */
const CONFIRMATIONS = [
  { name: "a supported walk", kind: "walk", stance: "supported", airborneAfterBreak: false, stabilizes: false },
  { name: "an airborne walk", kind: "walk", stance: "airborne", airborneAfterBreak: false, stabilizes: true },
  { name: "a direct-down step", kind: "downward", stance: "supported", airborneAfterBreak: true, stabilizes: null },
] as const;

test("movement waits for the effect and its observed world confirmation, and settles the body only when a walk needs it", async () => {
  for (const row of CONFIRMATIONS) {
    const world = flatWorld();
    const ledger = new ExpectedMutationLedger();
    const position = row.kind === "downward" ? { x: 0, y: 62, z: 0 } : { x: 1, y: 63, z: 0 };
    world.load(position, { stateId: 2 });
    let stance: NavigationObservation["stance"] = row.stance;
    let stabilized = false;
    let movementStarted = false;
    let controlsReleased = false;
    let finishEffect!: () => void;
    const effectIssued = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });
    const bot = new FakeNavigationBot();
    bot.observe = () => ({ ...observation(), stance });
    bot.clearOwnedControls = () => {
      controlsReleased = true;
    };
    bot.startEffect = () => {
      assert.equal(controlsReleased, true, row.name);
      if (row.airborneAfterBreak) stance = "airborne";
      return {
        issued: true,
        completion: effectIssued.then(() => ({ kind: "accepted" }) as const),
        cancel: () => undefined,
      };
    };
    bot.stabilize = async () => {
      if (row.stabilizes === null) throw new Error("downward movement must own its expected fall");
      stabilized = true;
      stance = "supported";
      return { kind: "stable" };
    };
    bot.prepareMovement = async (movement) => {
      if (row.stabilizes) assert.equal(stabilized, true, row.name);
      movementStarted = true;
      return { kind: "completed", arrival: movement.to };
    };
    const step: PlannedStep = {
      ...movementStep(row.kind, { x: 0, y: 63, z: 0 }, position),
      operations: [
        { kind: "break", position, expectedStateId: 2, toolType: null, brings: [] },
        { kind: "move", movement: row.kind, target: { x: position.x + 0.5, y: position.y, z: position.z + 0.5 } },
      ],
    };
    const execution = executeSingleStep({ step, world, bot, ledger });
    await nextTurn();
    assert.equal(movementStarted, false, `${row.name}: the move waits for the break`);

    const before = world.blockAt(position.x, position.y, position.z);
    world.load(position, { stateId: 0 });
    ledger.classify(
      { position, before, after: world.blockAt(position.x, position.y, position.z), worldRevision: world.revision },
      new Set(),
      Date.now(),
    );
    finishEffect();
    assert.equal((await execution).kind, "exhausted", row.name);
    assert.equal(movementStarted, true, row.name);
    assert.equal(stabilized, row.stabilizes === true, row.name);
  }
});

test("a replanned step enters its owned open doorway before restoration", async () => {
  const world = flatWorld();
  const position = { x: 1, y: 63, z: 0 };
  const traits = { activationGroup: "birch_door", openable: true };
  world.load(position, { stateId: 2, traits: { ...traits, open: false } });
  const passages = new OpenedPassages(world, "overworld");
  passages.remember(passages.closedAt(position));
  world.load(position, { stateId: 3, traits: { ...traits, open: true } });
  const step: PlannedStep = {
    ...walkStep("replanned-door-entry", 0, 1),
    preconditions: [
      {
        position,
        expected: {
          description: "open door state 3",
          matches: (block) => block.kind === "loaded" && block.stateId === 3,
        },
      },
    ],
  };
  const bot = new FakeNavigationBot();
  const result = await new RouteExecutor({
    context: {
      runId: "replan",
      world,
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: new AbortController().signal,
    },
    passages,
    plan: routePlan([step], { id: "replanned" }),
    stepStarted: () => undefined,
    phase: () => undefined,
    effectConfirmed: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  assert.equal(result.kind, "exhausted");
  assert.equal(bot.observe().position.x, 1.5);
});

test("route cancellation waits for an active physical effect to settle", async () => {
  let settleEffect!: () => void;
  let cancelCalled = false;
  const completion = new Promise<{ readonly kind: "failed"; readonly observation: string }>((resolve) => {
    settleEffect = () => resolve({ kind: "failed", observation: "Digging aborted" });
  });
  const bot = new FakeNavigationBot();
  bot.startEffect = () => ({
    issued: true,
    completion,
    cancel: () => {
      cancelCalled = true;
    },
  });
  const controller = new AbortController();
  const step: PlannedStep = {
    ...walkStep("cancelled-break", 0, 1),
    operations: [
      { kind: "break", position: { x: 1, y: 63, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
      { kind: "move", movement: "walk", target: { x: 1.5, y: 63, z: 0.5 } },
    ],
  };
  const execution = executeSingleStep({ step, world: flatWorld(), bot, signal: controller.signal });
  await nextTurn();

  controller.abort();
  await nextTurn();
  assert.equal(cancelCalled, true);

  let routeSettled = false;
  void execution.then(() => {
    routeSettled = true;
  });
  await nextTurn();
  assert.equal(routeSettled, false);

  settleEffect();
  assert.equal((await execution).kind, "cancelled");
});

// ── Ticks, handoffs, and steering ────────────────────────────────────────────

test("one physics-tick subscription advances a complete movement-only route", async () => {
  const bot = new TickDrivenBot();
  const steps = [walkStep("first", 0, 1), walkStep("second", 1, 2)];
  const result = routeExecutor({
    context: {
      runId: "run",
      world: flatWorld(),
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: new AbortController().signal,
    },
    plan: routePlan(steps, { id: "continuous-route", totalCost: 8 }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  await nextTurn();
  bot.tickAt(1);
  while (bot.preparations < 2) await nextTurn();
  bot.tickAt(2);
  bot.tickAt(2);
  assert.equal((await result).kind, "exhausted");
  assert.equal(bot.subscriptions, 1);
  assert.equal(bot.ticks.size, 0);
  assert.equal(bot.ownedControlCount, 0);
  assert.deepEqual(bot.executions, [{ end: "continuous" }, { end: "settled" }]);
});

test("a mixed-kind continuous handoff reuses the route tick's velocity snapshot", async () => {
  const bot = new TickDrivenBot();
  const controller = new AbortController();
  const approach = walkStep("approach", 0, 1);
  const next = stepUpStep("next", 1, 2);
  const result = routeExecutor({
    context: { runId: "run", world: flatWorld(), bot, ledger: new ExpectedMutationLedger(), signal: controller.signal },
    plan: routePlan([approach, next], { id: "snapshot-handoff", totalCost: 16 }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  await nextTurn();

  bot.tickAt(1.1, { x: 0.3, y: 0, z: 0 });
  while (bot.preparations < 2) await nextTurn();

  assert.equal(bot.snapshotCalls, 2);
  assert.deepEqual(bot.preparedVelocities, [STILL, { x: 0.3, y: 0, z: 0 }]);
  controller.abort();
  bot.tickAt(1.1);
  assert.equal((await result).kind, "cancelled");
});

test("a failed continuous handoff clears the controls it inherited", async () => {
  class FailedHandoffBot extends TickDrivenBot {
    clearCalls = 0;
    inheritedControlsAtFailure = 0;
    override clearOwnedControls() {
      this.clearCalls += 1;
      super.clearOwnedControls();
    }
    override async prepareMovement(
      step: PlannedStep,
      token: unknown,
      signal: AbortSignal,
      execution: MovementExecution,
      snapshot: () => MovementSnapshot,
    ) {
      if (this.preparations === 1) {
        this.preparations += 1;
        this.executions.push(execution);
        this.inheritedControlsAtFailure = this.controls;
        return { kind: "failed", observation: "The next controller could not be prepared." } as const;
      }
      return super.prepareMovement(step, token, signal, execution, snapshot);
    }
  }
  const bot = new FailedHandoffBot();
  const result = routeExecutor({
    context: {
      runId: "run",
      world: flatWorld(),
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: new AbortController().signal,
    },
    plan: routePlan([walkStep("first", 0, 1), walkStep("second", 1, 2)], { id: "failed-handoff", totalCost: 8 }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  await nextTurn();
  bot.tickAt(1);

  assert.equal((await result).kind, "failed");
  assert.equal(bot.inheritedControlsAtFailure > 0, true);
  assert.equal(bot.ownedControlCount, 0);
  // Once at the failed ownership transfer and once at route cleanup.
  assert.equal(bot.clearCalls, 2);
});

test("the route applies a gap controller's per-tick landing steering", async () => {
  const bot = new TickDrivenBot();
  const cancellation = new AbortController();
  const result = routeExecutor({
    context: {
      runId: "run",
      world: flatWorld(),
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: cancellation.signal,
    },
    plan: routePlan([gapStep("parkour", 3, 1)], { id: "steered-gap", totalCost: 20 }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  }).execute();
  await nextTurn();

  bot.tickAt(0.3, { x: 0.1, y: 0, z: 0 });

  assert.deepEqual(bot.steeringTargets, [{ x: 3.5, y: 64, z: 0.5 }]);
  cancellation.abort();
  bot.tickAt(0.3);
  assert.equal((await result).kind, "cancelled");
});

// ── Giving the body back ─────────────────────────────────────────────────────

test("route cancellation clears controls and detaches its physics-tick subscription", async () => {
  const bot = new TickDrivenBot();
  const controller = new AbortController();
  const execution = executeSingleStep({
    step: walkStep("cancelled", 0, 3),
    world: flatWorld(),
    bot,
    signal: controller.signal,
  });
  await nextTurn();
  controller.abort();
  bot.tickAt(0);
  assert.equal((await execution).kind, "cancelled");
  assert.equal(bot.subscriptions, 1);
  assert.equal(bot.ticks.size, 0);
  assert.equal(bot.ownedControlCount, 0);
});

test("route invalidation interrupts movement at a cleaned physical checkpoint", async () => {
  const bot = new TickDrivenBot();
  const executor = routeExecutor({
    context: {
      runId: "run",
      world: flatWorld(),
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: new AbortController().signal,
    },
    plan: routePlan([walkStep("invalidated", 0, 3)], { id: "invalidated-route" }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  });
  const execution = executor.execute();
  await nextTurn();
  executor.invalidate();
  assert.equal((await execution).kind, "invalidated");
  assert.equal(bot.ticks.size, 0);
  assert.equal(bot.ownedControlCount, 0);
});

test("a terminal world invalidation releases a cancelled jump without another physics tick", async () => {
  const bot = new TickDrivenBot();
  const control = new AbortController();
  const executor = routeExecutor({
    context: {
      runId: "terminated-gap",
      world: flatWorld(),
      bot,
      ledger: new ExpectedMutationLedger(),
      signal: control.signal,
    },
    plan: routePlan([gapStep("parkour", 4)], { id: "gap" }),
    stepStarted: () => undefined,
    phase: () => undefined,
    stepCompleted: () => "continue",
  });
  let settled = false;
  const completion = executor.execute().then((result) => {
    settled = true;
    return result;
  });
  await nextTurn();
  bot.tickAt(0.6, { x: 0.25, y: 0, z: 0 });
  control.abort("takeover");
  await Promise.resolve();
  assert.equal(settled, false, "Committed jump must retain ownership during ordinary cancellation.");
  assert.ok(bot.ownedControlCount > 0);
  executor.invalidate();
  assert.equal((await completion).kind, "cancelled");
  assert.equal(bot.ownedControlCount, 0);
  assert.equal(bot.ticks.size, 0);
});

test("a contact cancellation before the route tick still launches and lands a committed run-up", async () => {
  const bot = new TickDrivenBot();
  const controller = new AbortController();
  const world = flatWorld();
  world.load({ x: 1, y: 62, z: 0 }, { stateId: 0 });
  const execution = executeSingleStep({ step: gapStep("jump", 2), world, bot, signal: controller.signal });
  await nextTurn();
  bot.tickAt(0.4, { x: 0.2, y: 0, z: 0 });
  controller.abort("hostile in reach");
  bot.tickAt(0.61, { x: 0.21, y: 0, z: 0 });
  assert.equal(bot.lastIntent?.jump, true);
  assert.equal(bot.lastIntent?.forward, true);
  bot.knockback(1.2, 64, { x: 0.2, y: 0.1, z: 0 });
  bot.tickAt(2, { x: 0.02, y: 0, z: 0 });
  assert.equal((await execution).kind, "cancelled");
  assert.equal(bot.ownedControlCount, 0);
  assert.equal(bot.ticks.size, 0);
});

test("a cancelled step-up releases after knockback lands on another safe cell", async () => {
  const bot = new TickDrivenBot();
  const controller = new AbortController();
  const execution = executeSingleStep({
    step: stepUpStep("knocked-off-ascent", 0, 1),
    world: flatWorld(),
    bot,
    signal: controller.signal,
  });
  await nextTurn();
  controller.abort("hostile contact during ascent");
  bot.knockback(-1, 64, { x: -0.2, y: -0.2, z: 0 });
  assert.ok(bot.ownedControlCount > 0, "airborne handoff still retains steering");
  bot.tickAt(-1, { x: -0.03, y: 0, z: 0 });
  assert.equal((await execution).kind, "cancelled");
  assert.equal(bot.ownedControlCount, 0, "do not jump back toward the cancelled destination");
});

test("a cancelled landing brakes knockback before it carries the bot off its new ledge", async () => {
  const bot = new TickDrivenBot();
  const controller = new AbortController();
  const world = flatWorld();
  world.load({ x: 3, y: 62, z: 0 }, { stateId: 0 });
  const execution = executeSingleStep({
    step: stepUpStep("knocked-onto-ledge", 0, 1),
    world,
    bot,
    signal: controller.signal,
  });
  await nextTurn();
  controller.abort("hostile contact during ascent");
  bot.knockback(2.3, 64, { x: 0.3, y: -0.2, z: 0 });
  bot.tickAt(2.3, { x: 0.3, y: 0, z: 0 });
  const landingIntent = bot.lastIntent;
  // Its centre has crossed the edge, but the 0.6-wide body still rests on it.
  bot.tickAt(2.6, { x: 0.1, y: 0, z: 0 });
  const edgeIntent = bot.lastIntent;
  bot.tickAt(2.3);
  assert.equal((await execution).kind, "cancelled");
  assert.equal(landingIntent?.sneak, true, "retain the safe ledge while the knockback dissipates");
  assert.equal(landingIntent?.left, true, "crouch back toward the supporting block, strafing against the held heading");
  assert.deepEqual(bot.steeringTargets, [], "a landing correction never turns the head");
  assert.equal(landingIntent?.jump, false, "do not restart the cancelled ascent");
  assert.equal(edgeIntent?.sneak, true, "air under the centre does not mean the whole body lost support");
});
