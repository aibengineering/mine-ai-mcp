/**
 * One navigation run, from admission to settled outcome.
 *
 * Every test here drives `createNavigator().startRun` against the fake bot,
 * so the navigator's admission and cleanup and the run's search, execution,
 * and revision are proven together, as they run. What `runNavigation` adds
 * on top has its own test in `../navigate.test.ts`.
 */
import type { Goal } from "../goals/goal.js";
import { exactBlockGoal, itemPickupGoal, nearEntityGoal, nearGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createMovementCatalogue, type MovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { NavigationObservation } from "../world/world.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";

const walking = () => createMovementPolicy({ allowSprinting: false });
/** Commit as soon as there is a segment worth walking, so a run is made of continuations rather than one route. */
const EARLY_COMMIT = { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 } as const;

test("repeated start invalidation settles as planning_stalled and releases the navigation owner", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const bot = new FakeNavigationBot();
  bot.current = { ...bot.current, position: { ...bot.current.position, x: 0.99 } };
  const world = flatWorld();
  let retries = 0;
  const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => {
    if (event.kind === "search_started") {
      now += 4_000;
      if (event.reason === "start_changed") retries++;
    }
    if (event.kind === "search_slice")
      bot.current = { ...bot.current, position: { ...bot.current.position, x: bot.current.position.x < 1 ? 1.01 : 0.99 } };
  }) });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 6, y: 63, z: 0 }), policy: walking() });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed" || outcome.failure.kind !== "no_progress") assert.fail(JSON.stringify(outcome));
  assert.equal(outcome.failure.reason, "planning_stalled");
  assert.ok(retries >= 3);
  assert.equal(outcome.evidence.plans, 0);
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

// ── Admission, stopping, and cleanup ─────────────────────────────────────────

test("the service admits one run and settles from observed final state", async () => {
  const world = flatWorld();
  const actuator = new FakeNavigationBot();
  const navigator = createNavigator({ world, bot: actuator, createId: () => "run-1" });
  const admission = navigator.startRun({ goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy() });
  assert.equal(admission.kind, "started");
  assert.equal(
    navigator.startRun({ goal: exactBlockGoal({ x: 1, y: 63, z: 0 }), policy: createMovementPolicy() }).kind,
    "busy",
  );
  if (admission.kind !== "started") return;
  const outcome = await admission.handle.outcome;
  assert.equal(outcome.kind, "completed");
  assert.equal(actuator.current.position.x, 2.5);
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  // Measured after cleanup, so a leak would show here rather than being hidden.
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

test("a run stops in the words of whoever asked, before it moves, and a timeout reads as a timeout", async () => {
  const far = { goal: exactBlockGoal({ x: 6, y: 63, z: 0 }), policy: createMovementPolicy() };

  const caller = new AbortController();
  caller.abort("the requested quantity is in the inventory");
  const bot = new FakeNavigationBot();
  const byCaller = await settle(createNavigator({ world: flatWorld(), bot }), { ...far, signal: caller.signal });
  assert.equal(byCaller.kind, "stopped");
  if (byCaller.kind === "stopped") assert.equal(byCaller.reason, "the requested quantity is in the inventory");
  assert.equal(bot.current.position.x, 0.5);

  const timeout = AbortSignal.timeout(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const byTimeout = await settle(createNavigator({ world: flatWorld(), bot: new FakeNavigationBot() }), {
    ...far,
    signal: timeout,
  });
  assert.equal(byTimeout.kind, "stopped");
  if (byTimeout.kind === "stopped") assert.equal(byTimeout.reason, "navigation timeout");

  const world = flatWorld();
  const navigator = createNavigator({ world, bot: new FakeNavigationBot() });
  const admission = navigator.startRun(far);
  assert.equal(admission.kind, "started");
  if (admission.kind !== "started") return;
  navigator.cancelActive("operator stop");
  const byOperator = await admission.handle.outcome;
  assert.equal(byOperator.kind, "stopped");
  if (byOperator.kind === "stopped") assert.equal(byOperator.reason, "operator stop");
  assert.equal(navigator.active, null);
  assert.equal(world.listenerCount, 0);
  assert.equal(byOperator.evidence.cleanup.listeners, 0);
});

/** Each row breaks one thing a run depends on; the run must still release the navigator and say what failed. */
const BROKEN = [
  {
    name: "a failed control release",
    breakIt: (bot: FakeNavigationBot) => {
      bot.clearOwnedControls = () => {
        throw new Error("control release failed");
      };
    },
    message: "control release failed",
    lastEvents: ["cleanup_completed", "run_settled"],
  },
  {
    name: "a failed world subscription",
    breakIt: (_bot: FakeNavigationBot, world: ReturnType<typeof flatWorld>) => {
      world.subscribe = () => {
        throw new Error("world subscription failed");
      };
    },
    message: "world subscription failed",
  },
  {
    name: "a failed goal and a failed cleanup",
    breakIt: (bot: FakeNavigationBot) => {
      bot.clearOwnedControls = () => {
        throw new Error("control release failed");
      };
    },
    goal: {
      resolve() {
        throw new Error("goal resolution failed");
      },
    } satisfies Goal,
    message: "goal resolution failed; cleanup failed: control release failed",
  },
];

test("a run that cannot set up or clean up reports why, releases the navigator, and admits the next run", async () => {
  for (const row of BROKEN) {
    const world = flatWorld();
    const bot = new FakeNavigationBot();
    const events: string[] = [];
    const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => events.push(event.kind)) });
    const request = { goal: row.goal ?? exactBlockGoal({ x: 0, y: 63, z: 0 }), policy: createMovementPolicy() };
    const pristine = { subscribe: world.subscribe.bind(world), clearOwnedControls: bot.clearOwnedControls };
    row.breakIt(bot, world);

    const outcome = await settle(navigator, request);
    assert.equal(outcome.kind, "failed", row.name);
    if (outcome.kind !== "failed") continue;
    assert.deepEqual(outcome.failure, { kind: "internal_error", message: row.message }, row.name);
    assert.equal(outcome.evidence.cleanup.listeners, 0, row.name);
    assert.equal(world.listenerCount, 0, row.name);
    assert.equal(navigator.active, null, row.name);
    if (row.lastEvents) assert.deepEqual(events.slice(-2), row.lastEvents, row.name);

    world.subscribe = pristine.subscribe;
    bot.clearOwnedControls = pristine.clearOwnedControls;
    assert.equal(
      (await settle(navigator, { ...request, goal: exactBlockGoal({ x: 0, y: 63, z: 0 }) })).kind,
      "completed",
      row.name,
    );
  }
});

test("cancelling a stationary search releases its position hold", async () => {
  const bot = new FakeNavigationBot();
  const abort = new AbortController();
  let holding = false;
  bot.holdPosition = () => {
    holding = true;
    return () => {
      holding = false;
    };
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot,
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        assert.equal(holding, true);
        abort.abort("cancel during calculation");
      }
    }),
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: createMovementPolicy(),
    signal: abort.signal,
  });
  assert.equal(outcome.kind, "stopped");
  assert.equal(holding, false);
});

for (const cancelled of [false, true]) {
  test(`an airborne search retains its hold until landing before ${cancelled ? "cancellation" : "replanning"}`, async () => {
    const bot = new FakeNavigationBot();
    const abort = new AbortController();
    let holding = false;
    let hit = false;
    let landed = false;
    bot.holdPosition = () => {
      holding = true;
      return () => {
        holding = false;
      };
    };
    bot.stabilize = async () => {
      assert.equal(holding, true, "the search must not relinquish steering during knockback");
      bot.current = observation();
      landed = true;
      return { kind: "stable" };
    };
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (!hit && event.kind === "search_started") {
          hit = true;
          bot.current = { ...bot.current, stance: "airborne" };
          if (cancelled) abort.abort("reflex requested body during knockback");
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: createMovementPolicy(),
      signal: abort.signal,
    });
    assert.equal(outcome.kind, cancelled ? "stopped" : "completed");
    assert.equal(landed, true);
    assert.equal(holding, false);
  });
}

test("an arrival cancelled by observed pickup is stopped rather than an internal error", async () => {
  const abort = new AbortController();
  const errors: unknown[] = [];
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    telemetry: { emit: () => undefined, error: (_runId, cause) => errors.push(cause) },
  });
  const outcome = await settle(navigator, {
    goal: exactBlockGoal({ x: 0, y: 63, z: 0 }),
    policy: createMovementPolicy(),
    signal: abort.signal,
    onArrival: () => {
      abort.abort("the requested quantity is in the inventory");
      abort.signal.throwIfAborted();
      return { kind: "completed" };
    },
  });
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(errors, []);
});

// ── Continuing under one run ─────────────────────────────────────────────────

test("a non-terminal arrival continues under the same navigation run", async () => {
  const actuator = new FakeNavigationBot();
  let destination = 1;
  const events: string[] = [];
  const goal: Goal = {
    resolve(observed) {
      return exactBlockGoal({ x: destination, y: 63, z: 0 }).resolve(observed);
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "continuous-process",
    telemetry: onEvent((event) => {
      if (event.kind === "run_started") events.push("run");
      if (event.kind === "search_started") events.push(`search:${event.reason}`);
      if (event.kind === "goal_arrived") events.push(`arrival:${event.result}`);
    }),
  });
  const outcome = await settle(navigator, {
    goal,
    policy: walking(),
    onArrival: () => {
      if (destination === 1) {
        destination = 2;
        return { kind: "continue" };
      }
      return { kind: "completed" };
    },
  });

  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.equal(actuator.current.position.x, 2.5);
  assert.equal(outcome.evidence.searches, 2);
  assert.equal(outcome.evidence.continuations, 1);
  assert.equal(outcome.evidence.replans, 0);
  assert.deepEqual(events, [
    "run",
    "search:initial",
    "arrival:continue",
    "search:arrival_continuation",
    "arrival:completed",
  ]);
});

test("a calculation failure can revise a process goal under the same navigation run", async () => {
  let destination = 5;
  const events: string[] = [];
  const goal: Goal = {
    resolve(observed) {
      return exactBlockGoal({ x: destination, y: 63, z: 0 }).resolve(observed);
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "continuous-failure",
    telemetry: onEvent((event) => {
      if (event.kind === "run_started") events.push("run");
      if (event.kind === "search_started") events.push(`search:${event.reason}`);
      if (event.kind === "calculation_failed") events.push(`failure:${event.result}`);
    }),
  });
  const outcome = await settle(navigator, {
    goal,
    policy: walking(),
    searchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 0 },
    onCalculationFailure: () => {
      destination = 0;
      return { kind: "continue" };
    },
  });

  assert.equal(outcome.kind, "completed");
  assert.deepEqual(events, ["run", "search:initial", "failure:continue"]);
});

test("the next segment is searched for while the current one is being walked", async () => {
  // Baritone plans ahead for the same reason: a search that runs while the bot
  // is walking costs nothing it was going to spend standing still. The proof is
  // ordering — the continuation must be under way before the segment it follows
  // has finished being executed, not afterwards.
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const order: string[] = [];
  let holding = false;
  actuator.holdPosition = () => {
    assert.equal(holding, false);
    holding = true;
    return () => {
      holding = false;
    };
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "plan-ahead",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        assert.equal(holding, event.reason !== "segment_continuation");
        order.push(`search:${event.reason}`);
      }
      if (event.kind === "route_committed") {
        assert.equal(holding, false, "stationary controls must release before execution");
        order.push("committed");
      }
      if (event.kind === "step_completed") order.push("step");
    }),
  });
  await settle(navigator, { goal: nearGoal({ x: 5, y: 63, z: 0 }, 0), policy: walking(), searchLimits: EARLY_COMMIT });
  assert.equal(holding, false);

  // Serially every search is separated from the next by the segment it produced:
  // `search, committed, step..., search`. Planning ahead starts the follow-up as
  // soon as the segment is in hand, so two searches meet with no execution
  // between them — which cannot happen while searching and walking take turns.
  const overlapped = order.some(
    (entry, index) => entry.startsWith("search:") && (order[index + 1] ?? "").startsWith("search:"),
  );
  assert.ok(overlapped, `expected a continuation to start before its segment finished: ${order.join(", ")}`);
});

class OvershootingBot extends FakeNavigationBot {
  first = true;
  constructor(readonly overshoot = 1) {
    super();
  }
  override async prepareMovement(step: PlannedStep) {
    const arrival = this.first ? { ...step.to, x: step.to.x + this.overshoot } : step.to;
    this.first = false;
    this.arrive(arrival);
    return { kind: "completed", arrival } as const;
  }
}

test("a continuation the bot did not arrive at is stopped, not waited for", async () => {
  // The plan-ahead search runs under the larger budget. When the route ends
  // somewhere other than where that search assumed, its answer is useless and
  // the run must not stand still until it is finished. The proof is how many
  // slices the continuation gets: a stopped search ends within one slice of
  // the route ending, while an awaited one runs to its answer.
  const actuator = new OvershootingBot(2);
  actuator.current = observation(-5);
  const real = createMovementCatalogue();
  let slow = false;
  // Each expansion of the continuation costs more than a slice's budget, so an
  // awaited continuation would need one slice per node on the way to the goal.
  const catalogue: MovementCatalogue = {
    generate(state, context, digContext) {
      if (slow) {
        const until = performance.now() + 20;
        while (performance.now() < until) {
          /* burn one slice */
        }
      }
      return real.generate(state, context, digContext);
    },
  };
  let continuationId: string | null = null;
  let continuationSlices = 0;
  const abandoned: string[] = [];
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    catalogue,
    createId: () => "abandoned",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") {
        // Only the first continuation is under test; the replanned route
        // starts a second, legitimate one that is walked to and used.
        if (event.reason === "segment_continuation" && continuationId === null) continuationId = event.searchId;
        slow = event.searchId === continuationId;
      }
      if (event.kind === "search_slice" && event.searchId === continuationId) continuationSlices += 1;
      if (event.kind === "continuation_abandoned") abandoned.push(event.observation);
    }),
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: walking(),
    searchLimits: EARLY_COMMIT,
    continuationSearchLimits: { primaryTimeoutMs: 60_000, failureTimeoutMs: 60_000 },
  });

  assert.equal(outcome.kind, "completed");
  assert.notEqual(continuationId, null, "expected a continuation to have started");
  assert.equal(abandoned.length, 1, "the abandoned plan-ahead result is reported once, with why");
  assert.ok(
    continuationSlices <= 3,
    `expected the abandoned continuation to stop within a slice, but it ran ${continuationSlices} slices`,
  );
});

test("a failed plan-ahead search recalculates inline from the reached endpoint", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: actuator, createId: () => "continuation-budget" }),
    {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: walking(),
      searchLimits: EARLY_COMMIT,
      continuationSearchLimits: { primaryTimeoutMs: 0, failureTimeoutMs: 0 },
    },
  );

  assert.equal(outcome.kind, "completed");
  assert.ok(outcome.evidence.continuations >= 1);
  assert.ok(outcome.evidence.replans >= 1);
});

// ── A goal that changes while the run is under way ───────────────────────────

function movingEntityObservation(playerX: number, targetX: number): NavigationObservation {
  return {
    ...observation(playerX),
    entities: new Map([[7, { id: 7, position: { x: targetX + 0.5, y: 63, z: 0.5 }, width: 0.25, height: 0.25 }]]),
  };
}

class MovingEntityBot extends FakeNavigationBot {
  targetX = 5;
  moveAfterFirstStep = false;
  moved = false;

  constructor() {
    super();
    this.current = movingEntityObservation(0, this.targetX);
  }

  moveTargetTo(targetX: number) {
    this.targetX = targetX;
    this.current = movingEntityObservation(this.current.position.x - 0.5, targetX);
  }

  removeTarget() {
    this.current = observation(this.current.position.x - 0.5);
  }

  override async prepareMovement(step: PlannedStep) {
    this.current = movingEntityObservation(step.to.x, this.targetX);
    if (this.moveAfterFirstStep && !this.moved) {
      this.moved = true;
      this.moveTargetTo(4);
    }
    this.arrive(step.to, this.current);
    return { kind: "completed", arrival: step.to } as const;
  }
}

/**
 * The target moves, or vanishes, on the first search slice. A search limit
 * that expires on the first node makes the stale answer the only one on
 * offer, and the revised goal must win over it.
 */
const PLANNING_REVISIONS = [
  { change: "moves nearby", target: 4, searchLimits: undefined, expect: { kind: "completed", slices: null, x: null } },
  {
    change: "moves onto the bot",
    target: 0,
    searchLimits: { failureTimeoutMs: 0 },
    expect: { kind: "completed", slices: 1, x: 0.5 },
  },
  {
    change: "disappears",
    target: null,
    searchLimits: { failureTimeoutMs: 0 },
    expect: { kind: "failed", slices: 1, x: null },
  },
] as const;

test("a goal revised during planning keeps a route whose terminal state still satisfies it, or ends the run if it is gone", async () => {
  for (const row of PLANNING_REVISIONS) {
    const actuator = new MovingEntityBot();
    let revised = false;
    const navigator = createNavigator({
      world: flatWorld(),
      bot: actuator,
      telemetry: onEvent((event) => {
        if (revised || event.kind !== "search_slice") return;
        revised = true;
        if (row.target === null) actuator.removeTarget();
        else actuator.moveTargetTo(row.target);
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearEntityGoal({ id: 7 }, 2),
      policy: walking(),
      searchLimits: row.searchLimits,
    });
    assert.equal(outcome.kind, row.expect.kind, row.change);
    assert.equal(revised, true, row.change);
    assert.equal(outcome.evidence.searches, 1, row.change);
    assert.equal(outcome.evidence.replans, 0, row.change);
    if (row.expect.slices !== null) assert.equal(outcome.evidence.searchSlices, row.expect.slices, row.change);
    if (row.expect.x !== null) assert.equal(actuator.current.position.x, row.expect.x, row.change);
    if (outcome.kind === "failed") assert.equal(outcome.failure.kind, "invalid_goal", row.change);
  }
});

test("a target oscillating between two cells is not mistaken for a repeated search", async () => {
  // A dropped item can cross a cell boundary and cross back while the bot is
  // still planning and has not moved. Each abandoned search used to leave its
  // identity behind, so the third round matched the first and the run failed
  // with `repeated_search` having never taken a step. Removing the settling
  // wait before pickup made that reachable in ordinary play.
  const actuator = new MovingEntityBot();
  let flips = 0;
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "oscillating-goal",
    telemetry: onEvent((event) => {
      if (event.kind !== "search_slice" || flips >= 4) return;
      flips += 1;
      actuator.moveTargetTo(flips % 2 === 1 ? 4 : 5);
    }),
  });
  const outcome = await settle(navigator, {
    // An exact-cell goal, so a flip genuinely invalidates the route it was
    // planned for. A range goal would simply retain the plan and never reach
    // the ledger this guards.
    goal: itemPickupGoal({ id: 7 }),
    policy: walking(),
  });
  // Three flips is the smallest number that returns the target to its first
  // cell, which is the repeat the guard has to tell apart. How many more happen
  // depends on how many search slices the machine fits in before arrival.
  assert.ok(flips >= 3, `expected the target to flip at least three times, saw ${flips}`);
  assert.equal(outcome.kind, "completed");
});

test("a goal revised during execution keeps a route whose terminal state still satisfies it", async () => {
  const actuator = new MovingEntityBot();
  actuator.moveAfterFirstStep = true;
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: actuator, createId: () => "execution-revision" }),
    {
      goal: nearEntityGoal({ id: 7 }, 2),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(actuator.moved, true);
  assert.equal(outcome.evidence.searches, 1);
  assert.equal(outcome.evidence.replans, 0);
});

test("a revised goal retains a partial route that never promised to reach the old goal", async () => {
  const actuator = new FakeNavigationBot();
  actuator.current = observation(-5);
  const destination = exactBlockGoal({ x: 5, y: 63, z: 0 });
  let revised = false;
  let partialRouteObserved = false;
  const goal: Goal = {
    resolve(observed) {
      const snapshot = destination.resolve(observed);
      return snapshot.kind === "invalid"
        ? snapshot
        : { ...snapshot, revision: revised ? "same-target:latest" : "same-target:planned" };
    },
  };
  const navigator = createNavigator({
    world: flatWorld(),
    bot: actuator,
    createId: () => "partial-goal-revision",
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed" && !event.plan.complete) partialRouteObserved = true;
      if (event.kind === "step_completed") revised = true;
    }),
  });
  const outcome = await settle(navigator, { goal, policy: walking(), searchLimits: EARLY_COMMIT });

  assert.equal(outcome.kind, "completed");
  assert.equal(partialRouteObserved, true);
  assert.equal(revised, true);
  assert.equal(outcome.evidence.replans, 0);
  assert.equal(actuator.current.position.x, 5.5);
});

test("a discovered target replaces a partial exploration route that now leads away", async () => {
  const world = flatWorld();
  for (let x = 6; x <= 30; x += 1)
    for (let z = -5; z <= 5; z += 1) {
      world.load({ x, y: 62, z }, { stateId: 1 });
      for (let y = 63; y <= 65; y += 1) world.load({ x, y, z }, { stateId: 0 });
    }
  const actuator = new FakeNavigationBot();
  const destination = exactBlockGoal({ x: -3, y: 63, z: 0 });
  let discovered = false;
  let firstEndpoint = 0;
  let furthestX = 0;
  const goal: Goal = {
    resolve(observed) {
      return discovered
        ? destination.resolve(observed)
        : { kind: "active", revision: "exploring-east", isSatisfied: () => false, heuristic: (node) => -node.feet.x };
    },
  };
  const navigator = createNavigator({
    world,
    bot: actuator,
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed" && !discovered) firstEndpoint = event.plan.end.x;
      if (event.kind === "step_completed") {
        discovered = true;
        furthestX = Math.max(furthestX, actuator.current.position.x);
      }
    }),
  });
  const outcome = await settle(navigator, { goal, policy: walking(), searchLimits: EARLY_COMMIT });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.ok(firstEndpoint > 1, "the original partial route contains more than the discovery step");
  assert.ok(furthestX < firstEndpoint, "replan before walking to the obsolete exploration endpoint");
  assert.equal(outcome.evidence.replans, 1);
  assert.equal(actuator.current.position.x, -2.5);
});

// ── Movement that does not go to plan ────────────────────────────────────────

const attempts = (outcome: { evidence: { movementAttempts: Readonly<Partial<Record<string, number>>> } }) =>
  Object.values(outcome.evidence.movementAttempts).reduce((total: number, count) => total + (count ?? 0), 0);

test("a movement failure that reaches a new checkpoint stabilizes through a replacement search", async () => {
  class RecoveringBot extends FakeNavigationBot {
    failedOnce = false;
    override async prepareMovement(step: PlannedStep) {
      this.arrive(step.to);
      if (!this.failedOnce) {
        this.failedOnce = true;
        return {
          kind: "failed",
          observation: "The first movement stopped at its planned cell without settling.",
        } as const;
      }
      return { kind: "completed", arrival: step.to } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new RecoveringBot(), createId: () => "recovering-run" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.evidence.searches, 2);
  assert.equal(outcome.evidence.replans, 1);
  assert.equal(attempts(outcome), 3);
});

test("an observed overshoot skips the movement-only edge it already completed", async () => {
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new OvershootingBot(), createId: () => "overshoot-run" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.evidence.searches, 1);
  assert.equal(outcome.evidence.replans, 0);
  assert.equal(attempts(outcome), 2);
});

test("a calculation that fails after a movement failure reports what it was replanning around", async () => {
  let sealed = false;
  const observation_ = "The route planned to break with iron_pickaxe, which is not in the inventory.";
  class ToollessBot extends FakeNavigationBot {
    override async prepareMovement(step: PlannedStep) {
      this.arrive(step.to);
      sealed = true;
      return { kind: "failed", observation: observation_ } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new ToollessBot(), createId: () => "replan-after-failure" }),
    {
      goal: exactBlockGoal({ x: 3, y: 63, z: 0 }),
      // Once the tool is gone, no step is affordable: the replan has nowhere to go.
      policy: createMovementPolicy({
        allowSprinting: false,
        decideStep: () =>
          sealed ? { kind: "prohibited", reason: "sealed in after the failure" } : { kind: "allowed" },
      }),
    },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_path");
  if (outcome.failure.kind !== "no_path") return;
  assert.equal(outcome.failure.after?.observation, observation_);
});

test("each search plans with the scaffold the policy offers when that search starts", async () => {
  const world = flatWorld();
  // A four-block chasm across the whole world: no jump, drop, dig, or detour crosses it, only a bridge.
  for (const x of [1, 2, 3, 4])
    for (let z = -5; z <= 5; z += 1) for (const y of [59, 60, 61, 62]) world.load({ x, y, z }, { stateId: 0 });
  const bot = new FakeNavigationBot();
  bot.current = { ...observation(), inventory: new Map([[2, 4]]) };
  // The production policy reads its scaffold from the live inventory; the run
  // must read it when a search starts, not when the policy was made.
  let offered: { itemType: number; stateId: number } | null = null;
  const policy = Object.freeze({
    ...createMovementPolicy({ allowSprinting: false, allowParkour: false }),
    get scaffold() {
      return offered;
    },
  });
  const plans: (readonly PlannedStep[])[] = [];
  const navigator = createNavigator({
    world,
    bot,
    createId: () => "live-scaffold",
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed") plans.push(event.plan.steps);
    }),
  });
  offered = { itemType: 2, stateId: 1 };
  await settle(navigator, { goal: exactBlockGoal({ x: 5, y: 63, z: 0 }), policy });
  const placements =
    plans[0]?.flatMap((step) => step.operations.filter((operation) => operation.kind === "place")) ?? [];
  assert.equal(placements.length, 4);
  for (const operation of placements) if (operation.kind === "place") assert.equal(operation.placement.itemType, 2);
});

test("a run pushed back to where it began reports no progress after three routes", async () => {
  let executed = 0;
  // Every route walks to its cell and completes, and something moves the bot
  // back before the next observation, as water flow did beside a drop. The
  // inventory changes each time, so this is not the same search twice.
  class PushedBackBot extends FakeNavigationBot {
    override async prepareMovement(step: PlannedStep) {
      executed += 1;
      this.arrive({ x: 0, y: 63, z: 0 }, { ...observation(0, 63, 0), resourceRevision: `pushed:${executed}` });
      return { kind: "completed", arrival: { x: 0, y: 63, z: 0 } } as const;
    }
  }
  const outcome = await settle(
    createNavigator({ world: flatWorld(), bot: new PushedBackBot(), createId: () => "pushed-back" }),
    {
      goal: exactBlockGoal({ x: 1, y: 63, z: 0 }),
      policy: walking(),
    },
  );
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_progress");
  if (outcome.failure.kind !== "no_progress") return;
  assert.equal(outcome.failure.reason, "repeated_execution_checkpoint");
  assert.match(outcome.failure.observation, /3 executed routes in a row/);
  assert.equal(executed, 3);
});

test("a timed-out calculation carries its actual search statistics to the caller", async () => {
  const result = await settle(createNavigator({ world: flatWorld(), bot: new FakeNavigationBot() }), {
    goal: exactBlockGoal({ x: 100, y: 63, z: 0 }),
    policy: createMovementPolicy(),
    searchLimits: { failureTimeoutMs: 0 },
  });
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.failure.kind, "search_limit");
  if (result.failure.kind !== "search_limit") return;
  assert.equal(result.failure.search.visited, 1);
  assert.equal(result.failure.search.generated, 1);
  assert.equal(result.failure.search.slices, 1);
  assert.ok(result.failure.search.computeMs >= 0);
});

// ── The registered step field ────────────────────────────────────────────────

test("each search freezes one step field snapshot, and a request may opt out of the field altogether", async () => {
  // Every search's reads land in the bucket opened when it started, so a
  // snapshot leaking from one search into another shows up as two fingerprints
  // in one bucket.
  const buckets: Array<Set<string>> = [];
  let snapshots = 0;
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "field-freeze",
    telemetry: onEvent((event) => {
      if (event.kind === "search_started") buckets.push(new Set());
    }),
  });
  navigator.setStepFieldProvider(() => {
    snapshots += 1;
    const fingerprint = `snapshot-${snapshots}`;
    return {
      costAt: () => {
        buckets.at(-1)?.add(fingerprint);
        return 0;
      },
      fingerprint,
    };
  });
  const outcome = await settle(navigator, {
    goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
    policy: walking(),
    searchLimits: EARLY_COMMIT,
  });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") return;
  assert.ok(outcome.evidence.searches > 1, `expected several searches, saw ${outcome.evidence.searches}`);
  // Asked once per search: not once per run, which two live searches would
  // share, and not once per cell, which would let a mob move mid-search.
  assert.equal(snapshots, outcome.evidence.searches);
  for (const [index, used] of buckets.entries()) {
    assert.ok(used.size <= 1, `search ${index} read ${used.size} snapshots: ${[...used].join(", ")}`);
  }

  // What combat's approach, cover, and evade routes say. They walk toward the
  // thing the field prices, so the provider is never consulted for them.
  const asked = snapshots;
  await settle(navigator, { goal: nearGoal({ x: 3, y: 63, z: 0 }, 0), policy: walking(), stepField: null });
  assert.equal(snapshots, asked);
});

test("the step field's fingerprint is part of a search's identity", async () => {
  const navigator = createNavigator({
    world: flatWorld(),
    bot: new FakeNavigationBot(),
    createId: () => "field-identity",
  });
  navigator.setStepFieldProvider(() => ({ costAt: () => 0, fingerprint: "zombie@2,63,0" }));
  const outcome = await settle(navigator, {
    // A cell outside the loaded world, so the search reports no path, and a
    // process that asks to carry on regardless: the run then plans the very
    // same question a second time, which is the repeat the identity catches.
    goal: exactBlockGoal({ x: 20, y: 63, z: 0 }),
    policy: walking(),
    onCalculationFailure: () => ({ kind: "continue" }),
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.failure.kind, "no_progress");
  if (outcome.failure.kind !== "no_progress") return;
  assert.equal(outcome.failure.reason, "repeated_search");
  // A field that has moved is a different question, not the run going in
  // circles, so the fingerprint has to be in the identity that says so.
  assert.match(outcome.failure.observation, /\|field:zombie@2,63,0$/);
});

// ── The bot is not where the search thought ──────────────────────────────────

for (const displacement of ["airborne", "different_cell", "within_cell"] as const) {
  test(`stationary search revalidates its start after ${displacement} motion`, async () => {
    const bot = new FakeNavigationBot();
    let searches = 0;
    let stabilized = 0;
    const starts: number[] = [];
    bot.stabilize = async () => {
      stabilized++;
      bot.current = observation();
      return { kind: "stable" };
    };
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (event.kind === "search_started" && ++searches === 1) {
          bot.current =
            displacement === "airborne"
              ? { ...observation(), stance: "airborne" }
              : displacement === "different_cell"
                ? observation(1)
                : { ...observation(), position: { x: 0.8, y: 63, z: 0.5 } };
        }
        if (event.kind === "route_committed") {
          assert.notEqual(bot.current.stance, "airborne");
          assert.equal(event.plan.start.x, Math.floor(bot.current.position.x));
          starts.push(event.plan.start.x);
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 4, y: 63, z: 0 }, 0),
      policy: createMovementPolicy(),
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(stabilized, displacement === "airborne" ? 1 : 0);
    assert.equal(searches, displacement === "within_cell" ? 1 : 2);
    assert.deepEqual(starts, [displacement === "different_cell" ? 1 : 0]);
  });
}

for (const displacement of ["airborne", "different_cell"] as const) {
  test(`a continuation rechecks ${displacement} after waiting for its search`, async () => {
    const bot = new FakeNavigationBot();
    bot.current = observation(-5);
    bot.stabilize = async () => {
      bot.current = { ...bot.current, stance: "supported" };
      return { kind: "stable" };
    };
    let continuation: string | null = null;
    let displaced = false;
    const navigator = createNavigator({
      world: flatWorld(),
      bot,
      telemetry: onEvent((event) => {
        if (event.kind === "search_started" && event.reason === "segment_continuation" && !continuation)
          continuation = event.searchId;
        if (event.kind === "search_slice" && event.searchId === continuation && !displaced) {
          displaced = true;
          bot.current =
            displacement === "airborne"
              ? { ...bot.current, stance: "airborne" }
              : observation(Math.floor(bot.current.position.x) + 1);
        }
        if (event.kind === "route_committed") {
          assert.notEqual(bot.current.stance, "airborne");
          assert.equal(
            event.plan.start.x,
            Math.floor(bot.current.position.x),
            "committed start must still match after waiting",
          );
        }
      }),
    });
    const outcome = await settle(navigator, {
      goal: nearGoal({ x: 5, y: 63, z: 0 }, 0),
      policy: walking(),
      searchLimits: EARLY_COMMIT,
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(displaced, true);
  });
}
