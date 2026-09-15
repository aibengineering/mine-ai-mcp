import assert from "node:assert/strict";
import test from "node:test";
import { STILL, facing, gapStep, movementStep, stepUpStep } from "../../test-support/navigation.js";
import { stoppingDistance } from "../../world/player-physics.js";
import type { PlannedStep } from "../movements/movement.js";
import type { Position3 } from "../world/world.js";
import {
  type MovementExecution,
  type MovementSnapshot,
  type MovementTick,
  createMovementController,
} from "./movement-controller.js";

/** Every fixture here walks along +x unless it says otherwise. */
const yaw = facing(1, 0);
const CONTINUOUS: MovementExecution = { end: "continuous" };
const SETTLED: MovementExecution = { end: "settled" };
/** The shipped water rise. Only a fixture about sinking beneath a ceiling names another. */
const WATER_RISE = 0.6;

test("submerged arrival waits for a held depth band and seabed arrival waits for actual footing", () => {
  const step = movementStep("swim", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 });
  const floating = snap({ position: { x: 1.5, y: 63.1, z: 0.5 }, isInWater: true, onGround: false });
  const controller = createMovementController(step, floating, { end: "settled", swimDepth: 63, swimGrounded: true }, 0);
  for (let tick = 0; tick < 8; tick++) assert.equal(controller.advance(floating).kind, "running");
  const landed = { ...floating, position: { ...floating.position, y: 63 }, onGround: true };
  for (let tick = 0; tick < 3; tick++) assert.equal(controller.advance(landed).kind, "running");
  assert.equal(controller.advance(landed).kind, "arrived");
});

/** A physics snapshot. Anything unnamed is a still, dry, grounded body facing +x. */
function snap(fields: Partial<MovementSnapshot> & { position: Position3 }): MovementSnapshot {
  return { velocity: STILL, onGround: true, isInWater: false, climbing: false, yaw, ...fields };
}

/** Standing `projected` blocks along the run from the takeoff cell's centre, carrying `speed`. */
function gapSnapshot(projected: number, speed: number): MovementSnapshot {
  return snap({ position: { x: 0.5 + projected, y: 63, z: 0.5 }, velocity: { x: speed, y: 0, z: 0 } });
}

/** Airborne over the run at (`x`, `y`), carrying (`vx`, `vy`). */
function flight(x: number, y: number, vx: number, vy = 0): MovementSnapshot {
  return snap({ position: { x, y, z: 0.5 }, velocity: { x: vx, y: vy, z: 0 }, onGround: false });
}

function control(step: PlannedStep, start: MovementSnapshot, execution: MovementExecution, waterRise = WATER_RISE) {
  return createMovementController(step, start, execution, waterRise);
}

/** The tick, asserting the movement still owns the body. */
function running(
  tick: MovementTick,
  message = "the movement released the body",
): Extract<MovementTick, { kind: "running" }> {
  assert.equal(tick.kind, "running", message);
  if (tick.kind !== "running") throw new Error(message);
  return tick;
}

/** One drop of the given shape, aimed at the centre of `to`. */
function dropStep(to: Position3, from: Position3 = { x: 0, y: 63, z: 0 }): PlannedStep {
  return movementStep("drop", from, to);
}

test("a gap launches on its observed takeoff boundary, whatever speed it carries", () => {
  // Takeoff is spatial: every kind leaves at its own boundary with the run-up
  // it has, and earns the rest of the speed in flight.
  for (const { step, takeoffPosition } of [
    { step: gapStep("jump", 2), takeoffPosition: 0.5 },
    { step: gapStep("sprint_jump", 3), takeoffPosition: 0.7 },
    { step: gapStep("parkour", 4), takeoffPosition: 0.5 },
    { step: gapStep("parkour", 3, 1), takeoffPosition: 0.5 },
  ] as const) {
    const ready = control(step, gapSnapshot(takeoffPosition, 0), CONTINUOUS);
    assert.equal(ready.initialControls.forward, true, `${step.id} released airborne acceleration`);
    assert.equal(ready.initialControls.jump, true, `${step.id} waited for unavailable supported runway`);
  }

  // Carried speed does not bring the boundary closer.
  const jump = gapStep("jump", 2);
  assert.equal(control(jump, gapSnapshot(0.49, 0.2), CONTINUOUS).initialControls.jump, false);
  assert.equal(control(jump, gapSnapshot(0.5, 0.2), CONTINUOUS).initialControls.jump, true);

  // A gap accepts the same fractional supported feet height as the planner.
  const fractional = snap({ position: { x: 0.5, y: 62.875, z: 0.5 } });
  const lowFloor = control(jump, fractional, CONTINUOUS);
  assert.equal(lowFloor.advance(fractional).kind, "running");
  assert.equal(running(lowFloor.advance(snap({ position: { x: 1.05, y: 62.875, z: 0.5 } }))).controls.jump, true);

  // A damaging gap floor launches before the feet enter its cell.
  const damaging = control(gapStep("parkour", 2, 1), gapSnapshot(0.275, 0), {
    end: "settled",
    gapTakeoffPosition: 0.2,
  });
  assert.equal(damaging.initialControls.jump, true);
  assert.equal(damaging.initialControls.sprint, true);
});

test("a settled jump does not report the target cell while residual coast will leave it", () => {
  const base = gapStep("jump", 2);
  const alternate = { x: 3, y: 63, z: 0 };
  const step = { ...base, validArrivals: [...base.validArrivals, alternate] };
  const controller = control(step, gapSnapshot(0, 0), SETTLED);
  controller.advance(gapSnapshot(0.55, 0.2));
  controller.advance(flight(1.5, 64, 0.2));
  assert.equal(controller.advance(gapSnapshot(2.491, 0.04)).kind, "running");
  const coasted = controller.advance(gapSnapshot(2.513, 0.022));
  assert.deepEqual(coasted, { kind: "arrived", arrival: alternate });
});

test("a landing past the pad's centre brakes while any of the body still has support", () => {
  const fast = control(gapStep("parkour", 4), gapSnapshot(0, 0), SETTLED);
  fast.advance(gapSnapshot(0.55, 0.25));
  fast.advance(flight(2.5, 64, 0.3));
  // The fortress incident landed near the far lip at 0.259 blocks/tick.
  // Merely releasing forward let the body coast off the one-block pad.
  const touchdown = running(fast.advance(gapSnapshot(4.238, 0.259)), "Landing released the moving body");
  assert.equal(touchdown.steeringTarget, undefined, "braking never turns the head");
  assert.equal(touchdown.controls.back, true, "the coast would carry the body past the landing centre");
  assert.equal(touchdown.controls.forward, false);
  assert.equal(touchdown.controls.sneak, true);
  assert.equal(touchdown.controls.sprint, false);
  assert.equal(fast.advance(gapSnapshot(4.1, 0.01)).kind, "arrived");

  const grounded = control(gapStep("jump", 2), gapSnapshot(-0.1, 0), SETTLED);
  grounded.advance(gapSnapshot(0.526, 0.196));
  grounded.advance(flight(1.8, 64, 0.16));
  // Live netherrack collection touched down 0.01 past the pad's far edge.
  // Its centre was outside the cell, but 0.29 of the body remained supported.
  const edge = running(grounded.advance(gapSnapshot(2.51027, 0.18427)), "The supported edge landing was released");
  assert.equal(edge.controls.forward, false);
  assert.equal(edge.controls.back, true);
  assert.equal(edge.controls.sneak, true);
  assert.equal(grounded.advance(gapSnapshot(2.1, 0.01)).kind, "arrived");
});

test("cancelling a committed gap retains flight controls and settles the landing", () => {
  const controller = control(gapStep("parkour", 4), gapSnapshot(0, 0), CONTINUOUS);
  controller.advance(gapSnapshot(0.55, 0.25));
  assert.equal(controller.cancel(gapSnapshot(0.55, 0.25)), "settling");
  assert.equal(running(controller.advance(flight(2, 64, 0.3))).controls.forward, true);
  assert.equal(
    controller.advance(gapSnapshot(3.8, 0.2)).kind,
    "running",
    "Landing momentum must settle before ownership changes.",
  );
  assert.equal(controller.advance(gapSnapshot(4, 0.02)).kind, "arrived");

  // A run-up cancellation asks whether the residual momentum can stop on the
  // takeoff block, not whether the movement has launched.
  const moving = control(gapStep("jump", 2), gapSnapshot(0, 0), CONTINUOUS);
  moving.advance(gapSnapshot(0.3, 0.2));
  assert.equal(moving.cancel(gapSnapshot(0.3, 0.2)), "settling");
  assert.equal(control(gapStep("parkour", 4), gapSnapshot(0, 0), CONTINUOUS).cancel(gapSnapshot(0, 0)), "stopped");
  assert.equal(control(gapStep("jump", 2), gapSnapshot(0, 0), CONTINUOUS).cancel(gapSnapshot(0, 0)), "stopped");
});

test("cancelling before the movement tick at a launch lip retains the jump instead of coasting into lava", () => {
  const controller = control(gapStep("jump", 2), gapSnapshot(0, 0), CONTINUOUS);
  controller.advance(gapSnapshot(0.4, 0.2));
  // Combat's listener runs first. Physics has crossed the lip but the jump
  // controller's previous phase still says approaching.
  const atLip = gapSnapshot(0.61, 0.21);
  assert.equal(controller.cancel(atLip), "settling");
  assert.equal(running(controller.advance(atLip)).controls.jump, true);
  controller.advance(flight(1.7, 64, 0.2));
  assert.equal(controller.advance(gapSnapshot(2, 0.02)).kind, "arrived");
});

test("cancelling a drop retains its steering until the descending body has supported ground", () => {
  const controller = control(dropStep({ x: 1, y: 62, z: 0 }), gapSnapshot(0, 0), CONTINUOUS);
  const falling = snap({ position: { x: 0.85, y: 62.8, z: 0.5 }, velocity: { x: 0.1, y: 0, z: 0 }, onGround: false });
  assert.equal(controller.cancel(falling), "settling");
  assert.equal(running(controller.advance(falling)).controls.forward, true);
  assert.equal(
    controller.cancel({ ...falling, position: { x: 1.5, y: 62, z: 0.5 } }),
    "settling",
    "entering the destination coordinates in free fall is not a landing",
  );
  assert.equal(controller.cancel({ ...gapSnapshot(1, 0.01), position: { x: 1.5, y: 62, z: 0.5 } }), "stopped");
});

test("a drop corrects sideways knockback after releasing its approach", () => {
  const controller = control(dropStep({ x: 1, y: 61, z: 0 }), gapSnapshot(0, 0), SETTLED);
  const coast = snap({ position: { x: 1.5, y: 62.4, z: 0.5 }, onGround: false });
  assert.equal(running(controller.advance(coast)).controls.forward, false);
  const hit = running(
    controller.advance({
      ...coast,
      position: { x: 1.5, y: 62.68, z: 0.70525 },
      velocity: { x: 0, y: 0.275125, z: 0.20525 },
    }),
    "Drop released an airborne body",
  );
  assert.equal(hit.controls.left, true, "the coast is not an irreversible release of the corrective input");
  assert.equal(hit.controls.forward, false);
  assert.equal(hit.controls.sneak, false);
  assert.equal(hit.steeringTarget, undefined, "a sideways correction strafes; it never turns the head");
  const landing = controller.advance(snap({ position: { x: 1.5, y: 61, z: 0.6 }, velocity: { x: 0, y: 0, z: 0.08 } }));
  assert.equal(
    running(landing).controls.forward,
    false,
    "landing releases the corrective input while momentum settles",
  );
});

test("a cancelled gap settles on supported ground short of the superseded target, never in mid-air", () => {
  const launched = () => {
    const controller = control(gapStep("parkour", 4), gapSnapshot(0, 0), CONTINUOUS);
    controller.advance(gapSnapshot(0.55, 0.25));
    controller.cancel(gapSnapshot(0.55, 0.25));
    controller.advance(flight(2, 64, 0.3));
    return controller;
  };
  assert.equal(launched().advance(gapSnapshot(3.4, 0.02)).kind, "arrived");

  const unsupported = launched();
  assert.equal(unsupported.advance(gapSnapshot(4, 0.2)).kind, "running");
  assert.equal(
    unsupported.advance({ ...gapSnapshot(4, 0.02), onGround: false }).kind,
    "running",
    "Being in the target cell cannot replace current landing support.",
  );
  assert.equal(unsupported.advance(gapSnapshot(4, 0.02)).kind, "arrived");
});

test("the approach is released on how fast the bot is going, not on what kind of step it is", () => {
  const step = movementStep(
    "sprint",
    { x: 0, y: 63, z: 0 },
    { x: 5, y: 63, z: 0 },
    {
      id: "sprint-braking",
      expectedTicks: 20,
    },
  );
  const at = (x: number, speed: number) => snap({ position: { x, y: 63, z: 0.5 }, velocity: { x: speed, y: 0, z: 0 } });
  const start = at(0.5, 0);

  // Same cell, same distance to run, different speed. A sprinting bot needs to
  // stop pushing here; a crawling one does not, and the old constant table
  // could not tell them apart because it only knew the step was a `sprint`.
  // 0.5 blocks a tick is a carried sprint; 0.05 is a bot that has nearly
  // stalled. Both are 0.9 blocks from the target centre.
  assert.equal(running(control(step, start, SETTLED).advance(at(4.6, 0.5))).controls.forward, false);
  assert.equal(running(control(step, start, SETTLED).advance(at(4.6, 0.05))).controls.forward, true);
  const sideways = control(step, start, SETTLED).advance({ ...at(4.6, 0), velocity: { x: 0, y: 0, z: 0.5 } });
  assert.equal(running(sideways).controls.forward, true);
});

test("a drop through a vine lets the climbable lower the bot before pushing on", () => {
  const step = movementStep("drop", { x: 98, y: -2, z: 89 }, { x: 98, y: -3, z: 90 }, { expectedTicks: 12 });
  const at = (position: Position3, onGround: boolean) =>
    snap({ position, velocity: { x: 0, y: onGround ? 0 : -0.15, z: 0 }, onGround, climbing: true });
  // Handed over mid-slide: the feet cell is the source, 0.47 above its floor.
  // Pushing forward here meets the wall at head height and climbs the vine.
  const controller = control(step, at({ x: 98.3, y: -1.53, z: 89.6 }, false), CONTINUOUS);
  assert.equal(running(controller.advance(at({ x: 98.3, y: -1.7, z: 89.6 }, false))).controls.forward, false);
  assert.equal(running(controller.advance(at({ x: 98.3, y: -2, z: 89.6 }, true))).controls.forward, true);
  // Sliding through the destination cell is not arrival either.
  assert.equal(running(controller.advance(at({ x: 98.5, y: -2.4, z: 90.5 }, false))).controls.forward, false);
  assert.equal(controller.advance(at({ x: 98.5, y: -3, z: 90.5 }, true)).kind, "arrived");
});

test("stopping distance is the coast the bot actually has to cancel", () => {
  assert.equal(stoppingDistance({ x: 0, y: 0, z: 0 }), 0);
  // Vertical speed is not part of a horizontal approach.
  assert.equal(stoppingDistance({ x: 0, y: -3, z: 0 }), 0);
  // Diagonal travel coasts by its resultant, not by either component.
  assert.equal(stoppingDistance({ x: 0.3, y: 0, z: 0.4 }), 1);
});

test("swimming corrects toward its planned height without fighting a descent", () => {
  const swim = (targetY: number, targetX = 0) =>
    movementStep("swim", { x: 0, y: 63, z: 0 }, { x: targetX, y: targetY, z: 0 }, { expectedTicks: 20 });
  const start = snap({ position: { x: 0.5, y: 63, z: 0.5 }, onGround: false, isInWater: true });

  assert.equal(control(swim(64), start, CONTINUOUS).initialControls.jump, true);
  assert.equal(control(swim(63), start, CONTINUOUS).initialControls.jump, true);
  assert.equal(control(swim(62), start, CONTINUOUS).initialControls.jump, false);

  // The live falling-column trap held the feet 0.6 blocks too high to fit
  // beneath the next cell's ceiling. Sink before trying to cross its edge.
  const lowCeiling = control(swim(63, 1), start, CONTINUOUS, 0);
  const beneathEdge = running(lowCeiling.advance({ ...start, position: { x: 0.7, y: 63.6, z: 0.5 } }));
  assert.equal(beneathEdge.controls.jump, false);
  assert.equal(beneathEdge.controls.forward, true);
  const sinking = lowCeiling.advance({ ...start, position: { x: 0.7, y: 62.95, z: 0.5 } });
  assert.equal(running(sinking).controls.jump, true);

  const surfacing = control(swim(64), start, CONTINUOUS);
  const heldColumn = running(surfacing.advance({ ...start, position: { x: 0.62, y: 63.2, z: 0.5 } }));
  assert.equal(heldColumn.controls.jump, true);
  assert.equal(heldColumn.controls.back, true, "hold the column by strafing against the heading");
  assert.equal(heldColumn.controls.forward, false);
  assert.equal(heldColumn.steeringTarget, undefined, "a column hold never turns the head");

  const horizontal = control(swim(63, 1), start, CONTINUOUS);
  const correction = horizontal.advance({
    ...start,
    position: { x: 0.8, y: 62.8, z: 0.5 },
    velocity: { x: 0.1, y: -0.1, z: 0 },
  });
  assert.equal(running(correction).controls.jump, true);
  const waterline = horizontal.advance({ ...start, position: { x: 1.5, y: 62.95, z: 0.5 } });
  assert.equal(running(waterline).controls.jump, true);

  // Entering a destination cell is not enough: at a corner the remaining
  // sideways momentum would carry the body past its safe corridor.
  const drifting = running(
    horizontal.advance({ ...start, position: { x: 1.05, y: 63.4, z: 0.5 }, velocity: { x: 0.1, y: 0, z: 0.04 } }),
  );
  assert.equal(drifting.controls.jump, true);
  assert.equal(drifting.controls.left, true, "counter the sideways drift by strafing");
  assert.equal(drifting.steeringTarget, undefined);

  const corner = control(swim(63, 1), start, CONTINUOUS);
  const aligning = running(corner.advance({ ...start, position: { x: 0.8, y: 63, z: 0.73 } }));
  assert.equal(aligning.controls.forward, true);
  assert.deepEqual(aligning.steeringTarget, { x: 1, y: 63, z: 0.5 }, "correct the corridor while advancing");
  const aligned = running(corner.advance({ ...start, position: { x: 0.8, y: 63, z: 0.6 } }));
  assert.equal(aligned.controls.forward, true);
  assert.equal(aligned.controls.left, true);
  assert.equal(aligned.steeringTarget, undefined);
  // The tree-bank current holds this sideways offset while opposing forward
  // travel. Pure sideways alignment never advances into the destination cell.
  const againstCurrent = running(corner.advance({ ...start, position: { x: 0.8, y: 63, z: 0.34 } }));
  assert.equal(againstCurrent.controls.forward, true);
  assert.equal(againstCurrent.controls.right, true);

  const crossing = control(
    movementStep("swim", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 1 }, { expectedTicks: 20 }),
    start,
    CONTINUOUS,
  );
  assert.equal(crossing.advance({ ...start, position: { x: 0.98, y: 63, z: 1.02 } }).kind, "running");
  assert.equal(crossing.advance({ ...start, position: { x: -0.02, y: 63, z: 1.02 } }).kind, "failed");
});

test("an airborne gap steers toward its landing and brakes only when the coast would carry it past", () => {
  const rising = control(
    gapStep("parkour", 3, 1),
    { ...gapSnapshot(0.5, 0), velocity: { x: 0, y: 0, z: 0.1 } },
    CONTINUOUS,
  );
  assert.equal(rising.initialControls.jump, true);
  assert.equal(rising.initialControls.forward, true);
  assert.equal(rising.initialControls.sprint, true);
  const airborne = running(
    rising.advance(
      snap({ position: { x: 1.1, y: 63.4, z: 0.6 }, velocity: { x: 0.12, y: 0.2, z: 0.08 }, onGround: false }),
    ),
  );
  assert.deepEqual(airborne.steeringTarget, { x: 3.5, y: 64, z: 0.5 });
  assert.equal(airborne.controls.forward, true);
  assert.equal(airborne.controls.sprint, true);
  assert.equal(airborne.controls.jump, false);

  // An ascending gap brakes before carrying its airborne body beyond the landing.
  const beyond = control(gapStep("parkour", 2, 1), gapSnapshot(0.5, 0.25), CONTINUOUS);
  const overshooting = running(beyond.advance(flight(2.21, 64.249, 0.282, 0.083)));
  assert.equal(overshooting.controls.forward, false);
  assert.equal(overshooting.controls.back, true);
  assert.equal(overshooting.controls.sprint, false);

  // Native soul-sand crossing: the leading edge reaches the level landing at
  // x=2, but braking here leaves the trailing edge in the lava at touchdown.
  const straddling = control(
    gapStep("jump", 2),
    { ...gapSnapshot(0.54, 0.21), position: { x: 1.04, y: 62.875, z: 0.5 } },
    CONTINUOUS,
  );
  const lip = running(straddling.advance(flight(1.84, 63.899, 0.171, -0.152)));
  assert.equal(lip.controls.forward, true);
  assert.equal(lip.controls.back, false);
});

test("a gap keeps moving after touching safe ground before its declared landing", () => {
  const controller = control(gapStep("parkour", 4), gapSnapshot(0.5, 0), CONTINUOUS);
  controller.advance(flight(1.2, 63.3, 0.2, 0.2));
  const earlyTouchdown = running(
    controller.advance(snap({ position: { x: 3.1, y: 63, z: 0.5 }, velocity: { x: 0.15, y: 0, z: 0 } })),
  );
  assert.equal(earlyTouchdown.controls.forward, true);
  assert.deepEqual(earlyTouchdown.steeringTarget, { x: 4.5, y: 63, z: 0.5 });
  assert.equal(running(controller.advance(gapSnapshot(3.4, 0.15))).controls.forward, true);
});

test("a gap controller fails instead of launching after it has fallen off the takeoff support", () => {
  const controller = control(gapStep("parkour", 3, 1), gapSnapshot(0, 0), CONTINUOUS);
  const belowTakeoff = snap({ position: { x: 2.5, y: 62, z: 0.5 }, velocity: { x: 0.3, y: 0, z: 0 } });
  assert.equal(controller.advance(belowTakeoff).kind, "failed");
});

test("a jump inherited from a descent waits to land on its takeoff support", () => {
  const controller = control(gapStep("jump", 2), flight(0.6, 63.7, 0.03, -0.2), CONTINUOUS);

  assert.deepEqual(controller.initialControls, {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  });
  assert.equal(running(controller.advance(flight(0.62, 63.2, 0.02, -0.3))).controls.forward, false);

  const landed = running(controller.advance(gapSnapshot(0.12, 0)));
  assert.equal(landed.controls.forward, true);
  assert.equal(landed.controls.jump, false);
  assert.equal(running(controller.advance(gapSnapshot(0.5, 0.1))).controls.jump, true);
});

test("a settled gap reads inherited velocity before handing off", () => {
  const step = gapStep("jump", 2);
  const start = gapSnapshot(0.5, 0.08);
  const sliding = control(step, start, SETTLED);
  const stopped = control(step, start, SETTLED);
  const airborne = flight(1.2, 63.4, 0.1, 0.2);

  sliding.advance(airborne);
  stopped.advance(airborne);
  assert.equal(sliding.advance(gapSnapshot(1.6, 0.1)).kind, "running");
  assert.equal(stopped.advance(gapSnapshot(1.6, 0.04)).kind, "arrived");
});

test("a continuous step-up brakes inherited speed and hands off only after landing", () => {
  const step = stepUpStep("carried-step-up", 1, 2);
  const controller = control(
    step,
    snap({ position: { x: 1.7, y: 63, z: 0.5 }, velocity: { x: 0.4, y: 0, z: 0 } }),
    CONTINUOUS,
  );

  assert.equal(controller.initialControls.forward, false);
  assert.equal(controller.initialControls.jump, true);
  const airborne = flight(2.1, 64, 0.2, 0.2);
  const flying = running(controller.advance(airborne));
  assert.equal(flying.controls.forward, false);
  assert.equal(flying.controls.jump, false);
  assert.deepEqual(flying.steeringTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(controller.advance({ ...airborne, onGround: true }).kind, "arrived");
});

test("a constrained step-up waits for Baritone's alignment before jumping", () => {
  const step = stepUpStep("head-bonk-step-up", 0, 1);
  const start = snap({ position: { x: 0, y: 63, z: 0.5 }, velocity: { x: 0.2, y: 0, z: 0 } });
  const constrained: MovementExecution = { end: "continuous", stepUpHeadBonkClear: false };
  const controller = control(step, start, constrained);

  assert.equal(controller.initialControls.jump, false);
  const aligned = controller.advance(snap({ position: { x: 0.4, y: 63, z: 0.5 }, velocity: { x: 0.08, y: 0, z: 0 } }));
  assert.equal(running(aligned).controls.jump, true);

  const lateral = control(step, start, constrained).advance(
    snap({ position: { x: 0.4, y: 63, z: 0.75 }, velocity: { x: 0.08, y: 0, z: 0.12 } }),
  );
  assert.equal(running(lateral).controls.jump, false);
});

test("a water exit keeps jumping until the feet clear the ledge", () => {
  const start = snap({ position: { x: 0.5, y: 63, z: 0.5 }, onGround: false, isInWater: true });
  const controller = control(stepUpStep("water-exit", 0, 1), start, SETTLED);
  const nearLip = controller.advance({ ...start, position: { x: 0.7, y: 63.98, z: 0.5 } });
  assert.equal(running(nearLip).controls.jump, true);
  const risingAtCorner = running(
    controller.advance({ ...start, position: { x: 0.69, y: 64.2, z: 0.67 }, isInWater: false }),
  );
  assert.equal(risingAtCorner.controls.forward, true);
  assert.equal(risingAtCorner.steeringTarget, undefined, "at the lip the heading is held, not recomputed");
  assert.equal(risingAtCorner.controls.jump, false);
});

test("a climb holds jump only while ascending; descending lets the ladder lower the bot", () => {
  const climb = (fromY: number, toY: number) =>
    movementStep("climb", { x: 0, y: fromY, z: 0 }, { x: 0, y: toY, z: 0 }, { expectedTicks: 6 });
  const onLadder = (y: number) => snap({ position: { x: 0.5, y, z: 0.5 }, onGround: false, climbing: true });

  const up = control(climb(63, 64), onLadder(63), CONTINUOUS);
  assert.equal(up.initialControls.jump, true);
  assert.equal(up.initialControls.forward, false, "a vertical climb has no heading to push along");
  assert.equal(running(up.advance(onLadder(63.4))).steeringTarget, undefined);
  assert.equal(up.advance(onLadder(64)).kind, "arrived");

  const down = control(climb(64, 63), onLadder(64), CONTINUOUS);
  assert.equal(down.initialControls.jump, false, "jump on a ladder climbs; a descent releases it");
  assert.equal(down.advance(onLadder(64.4)).kind, "running");
  assert.equal(down.advance(onLadder(63.9)).kind, "arrived", "the feet entering the lower cell is the arrival");

  // Standing on the ladder's plate against the wall, 0.15 short of the column
  // centre: walk off it toward the centre, then release once the ladder holds.
  const fromTop = control(climb(64, 63), onLadder(64), CONTINUOUS);
  const onPlate = running(
    fromTop.advance({ ...onLadder(64), position: { x: 0.35, y: 64, z: 0.5 }, onGround: true, climbing: false }),
  );
  assert.equal(onPlate.controls.forward, true, "step off the plate toward the column centre");
  assert.equal(onPlate.steeringTarget, undefined, "a column has no heading to face");
  // A hair short of the centre the body still overlaps the plate: keep pushing.
  const nearCentre = fromTop.advance({
    ...onLadder(64),
    position: { x: 0.49, y: 64, z: 0.5 },
    onGround: true,
    climbing: false,
  });
  assert.equal(running(nearCentre).controls.forward, true);
  // In the column and drifting west on the momentum of stepping in: hold the
  // centre against the air coast, so the body cannot leave a vine's open side.
  const drifting = running(
    fromTop.advance({
      ...onLadder(64.3),
      velocity: { x: -0.08, y: -0.15, z: 0 },
      position: { x: 0.35, y: 64.3, z: 0.5 },
    }),
  );
  assert.equal(drifting.controls.forward, true, "push back toward the column centre");
  assert.equal(drifting.steeringTarget, undefined);
  assert.equal(fromTop.advance(onLadder(63.95)).kind, "arrived");

  // Landed three blocks below the next cell: the body fell out of the column.
  const fell = control(climb(64, 63), onLadder(64), CONTINUOUS);
  assert.equal(fell.advance({ ...onLadder(60), onGround: true, climbing: false }).kind, "failed");
});

test("an upward vine climb cancels inherited sprint drift before the body leaves the column", () => {
  const step = movementStep("climb", { x: 32, y: 91, z: 110 }, { x: 32, y: 92, z: 110 }, { expectedTicks: 6 });
  // Retained run 6e8aea78..., 2026-09-13: the sprint approach handed the
  // climb -0.150 blocks/tick along x. Jump raised the body normally, but the
  // neutral horizontal controls let it cross x=32.30, leave the vine and fall.
  const entering = snap({
    position: { x: 32.812055530524155, y: 91, z: 110.45672282026987 },
    velocity: { x: -0.15015703786897125, y: -0.0784000015258789, z: 0.0161359790683359 },
    onGround: true,
    climbing: true,
  });
  const controller = control(step, entering, CONTINUOUS);
  const drifting = running(
    controller.advance({
      ...entering,
      position: { x: 32.58015553052416, y: 91.5375999891758, z: 110.48166904390952 },
      velocity: { x: -0.074529, y: 0.11760000228881837, z: 0.008017322559893377 },
      onGround: false,
      climbing: true,
    }),
  );
  assert.equal(drifting.controls.jump, true, "regular vines climb from jump input without wall collision");
  assert.equal(drifting.controls.forward, true, "correct back toward the vine column centre");
  assert.equal(drifting.steeringTarget, undefined, "correction preserves the existing look direction");

  const next = control(
    movementStep("climb", { x: 32, y: 92, z: 110 }, { x: 32, y: 93, z: 110 }, { expectedTicks: 6 }),
    { ...entering, position: { x: 32.31992478256516, y: 92.0079999983311, z: 110.50966289658953 } },
    CONTINUOUS,
  );
  assert.equal(
    next.advance({
      ...entering,
      position: { x: 31.973192970252597, y: 93.10324802189072, z: 110.53918276221536 },
      velocity: { x: -0.019902369575559548, y: -0.042288957922058, z: 0 },
      onGround: false,
      climbing: false,
    }).kind,
    "failed",
    "once the body has left the column, replan instead of waiting out the climb deadline",
  );
});

test("a drop with no safe runout settles before handing momentum into a turn", () => {
  const controller = control(
    dropStep({ x: 1, y: 62, z: 0 }),
    snap({ position: { x: 0.5, y: 63, z: 0.5 }, velocity: { x: 0.25, y: 0, z: 0 } }),
    CONTINUOUS,
  );
  const landing = snap({ position: { x: 1.2, y: 62, z: 0.5 }, velocity: { x: 0.25, y: 0, z: 0 } });
  assert.equal(running(controller.advance(landing)).controls.forward, false);
  assert.equal(controller.advance({ ...landing, velocity: { x: 0.01, y: 0, z: 0 } }).kind, "arrived");
});

test("an overshot step-up strafes back over its tread without turning its head", () => {
  const step = stepUpStep("overshot-step-up", -1, -2);
  const heading = facing(-1, 0);
  const start = {
    ...snap({ position: { x: -0.5, y: 63, z: 0.5 }, velocity: { x: -0.3, y: 0, z: 0 } }),
    yaw: heading,
  };
  const controller = control(step, start, CONTINUOUS);
  // Airborne 0.4 past the tread centre at -1.5 and still drifting away from it.
  const overshot: MovementSnapshot = {
    ...start,
    position: { x: -1.9, y: 64, z: 0.5 },
    velocity: { x: -0.1, y: 0, z: 0 },
    onGround: false,
  };
  const correction = running(controller.advance(overshot));
  assert.equal(correction.controls.back, true, "push against the held heading instead of turning to face the centre");
  assert.equal(correction.controls.forward, false);
  assert.equal(correction.steeringTarget, undefined, "a centre behind the body is not a heading");
  // On the ground the cell is the arrival; there is nothing to walk back to.
  assert.equal(controller.advance({ ...overshot, velocity: { x: -0.04, y: 0, z: 0 }, onGround: true }).kind, "arrived");
});

test("a grounded step-up rearms jump once before declaring a stall", () => {
  const stalled = snap({ position: { x: 74.7, y: 63, z: 0.5 } });
  const controller = control(stepUpStep("stalled-step-up", 74, 75), stalled, CONTINUOUS);

  let rearm: MovementTick | undefined;
  for (let tick = 0; tick < 6; tick += 1) rearm = controller.advance(stalled);
  assert.equal(running(rearm!).controls.jump, false);
  assert.equal(running(controller.advance(stalled)).controls.jump, true);
});

/**
 * A climbable caught in mid air ends the movement that was crossing it.
 *
 * Prismarine clamps the descent to 0.15 a tick on a ladder or vine and leaves
 * the horizontal speed untouched, so forward and sprint held through the
 * contact carry the body across the column's one block of width and out the
 * far side, where the fall resumes. Two live incidents on 2026-09-13:
 * bd95619b, a four-block parkour that caught a vine at x=72.97, held both
 * controls for seven ticks, left at x=74.34 and fell nineteen blocks; and
 * 97c795ac, a sprint off a ledge that drifted a block sideways out of its
 * column and fell five. Both controllers answer a hanging body the same way:
 * stop pushing, and strafe back over the column.
 */
test("a body that catches a vine in flight stops pushing and holds the column", () => {
  // The parkour of incident bd95619b, mid-arc and drifting past the column.
  const gap = control(gapStep("parkour", 4), gapSnapshot(0, 0.3), CONTINUOUS);
  for (let tick = 0; tick < 4; tick += 1) gap.advance(gapSnapshot(tick * 0.3, 0.3));
  const inFlight = running(gap.advance(flight(4.0, 63.2, 0.3, -0.2)));
  assert.equal(inFlight.controls.forward, true, "an ordinary arc keeps its run-up");

  const caught = running(
    gap.advance({ ...flight(4.9, 62.8, 0.28, -0.15), climbing: true }),
    "the movement abandoned the body mid-column",
  );
  assert.equal(caught.controls.forward, false, "forward is what carries the body out of the column");
  assert.equal(caught.controls.sprint, false);
  assert.equal(caught.controls.back, true, "strafe back over the column against the coast");

  // The sprint of incident 97c795ac, off the lip and into the column.
  const step = movementStep("sprint", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 });
  const walking = control(step, snap({ position: { x: 0.5, y: 63, z: 0.5 } }), CONTINUOUS);
  const hanging = running(
    walking.advance(snap({ position: { x: 1.9, y: 62.7, z: 0.5 }, velocity: { x: 0.2, y: -0.15, z: 0 }, onGround: false, climbing: true })),
  );
  assert.equal(hanging.controls.forward, false);
  assert.equal(hanging.controls.sprint, false);
  assert.equal(hanging.controls.back, true, "the column centre is behind a body that has drifted past it");
});
