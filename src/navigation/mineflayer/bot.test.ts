import { installNetherVinePhysics, MineflayerBot, type MineflayerBotSurface } from "./bot.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../world/memory-world.js";
import type { Position3 } from "../world/world.js";
import { executeBotMovement, movementStep } from "../../test-support/navigation.js";

/** A Mineflayer surface that does nothing, standing on the origin, with the given parts replaced. */
function surface(overrides: Partial<MineflayerBotSurface>): MineflayerBotSurface {
  return {
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false },
    game: { dimension: "overworld" },
    entities: {},
    inventory: { items: () => [] },
    setControlState: () => undefined,
    waitForTicks: async () => undefined,
    lookAt: async () => undefined,
    equip: async () => undefined,
    blockAt: () => null,
    visibleDigAim: (position) => ({ x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }),
    dig: async () => undefined,
    stopDigging: () => undefined,
    placementObstacle: () => null,
    placeBlock: async () => undefined,
    activateBlock: async () => undefined,
    on: () => undefined,
    off: () => undefined,
    ...overrides,
  };
}

test("the pinned physics compatibility restores Nether vine ascent and descent velocity", () => {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },
    velocity: { x: 0.3, y: -0.23, z: -0.3 },
    isCollidedHorizontally: false,
    onGround: false,
    isInWater: false,
  };
  let tick: () => void = () => undefined;
  let velocityPacket: () => void = () => undefined;
  let jump = false;
  let sneak = false;
  let block = "twisting_vines_plant";
  const bot = surface({
    entity,
    blockAt: () => ({ name: block }),
    getControlState: (control) => (control === "jump" ? jump : sneak),
    on: (_event, listener) => {
      tick = listener;
    },
    onSelfVelocity: (listener) => {
      velocityPacket = listener;
      return () => {
        velocityPacket = () => undefined;
      };
    },
  });
  const release = installNetherVinePhysics(bot);

  tick();
  assert.equal(entity.velocity.y, -0.15);
  assert.ok(Math.abs(entity.velocity.x - 0.1365) < 1e-12);
  assert.ok(Math.abs(entity.velocity.z + 0.1365) < 1e-12);
  entity.velocity.x = -0.32;
  velocityPacket();
  assert.ok(Math.abs(entity.velocity.x + 0.1365) < 1e-12, "a between-tick knockback is capped before it moves");
  jump = true;
  tick();
  assert.ok(Math.abs(entity.velocity.y - 0.1176) < 1e-12);
  jump = false;
  sneak = true;
  entity.velocity.y = -0.1;
  tick();
  assert.equal(entity.velocity.y, 0);
  sneak = false;
  entity.isCollidedHorizontally = true;
  entity.velocity.y = -0.15;
  tick();
  assert.ok(Math.abs(entity.velocity.y - 0.1176) < 1e-12, "horizontal collision climbs without jump");
  block = "air";
  entity.velocity = { x: 0.3, y: -0.23, z: -0.3 };
  tick();
  assert.deepEqual(entity.velocity, { x: 0.3, y: -0.23, z: -0.3 }, "non-vines retain pinned physics velocity");
  release();
});

test("water touching the body is a swimming stance even when its feet and head cells are air", () => {
  const entity = { position: { x: 0.3, y: 63.06, z: 0.7545 }, onGround: false, isInWater: true };
  const bot = surface({ entity, blockAt: () => ({ name: "air" }), visibleDigAim: () => null });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  assert.equal(actuator.observe().stance, "swimming");
  entity.onGround = true;
  assert.equal(actuator.observe().stance, "supported");
  entity.onGround = false;
  entity.isInWater = false;
  assert.equal(actuator.observe().stance, "airborne");
});

test("the Mineflayer actuator passes Vec3 positions to the runtime", async () => {
  const position = { x: 0.5, y: 63, z: 0.5 };
  let lookedAt: Vec3 | undefined;
  const bot = surface({
    entity: { position, onGround: true, isInWater: false },
    waitForTicks: async () => {
      position.x = 1.5;
    },
    lookAt: async (target) => {
      assert.equal(target instanceof Vec3, true);
      lookedAt = target as Vec3;
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 });
  const result = await executeBotMovement(actuator, step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.deepEqual(lookedAt, new Vec3(1.5, 64, 0.5));
});

test("a step whose centre the body has already passed keeps the current heading", async () => {
  // Handed over 0.1 past the target centre, the old aim looked back at it and
  // the bot turned around; the heading now stays where the last step left it.
  const position = { x: 1.6, y: 63, z: 0.5 };
  let lookedAt = 0;
  const bot = surface({
    entity: { position, onGround: true, isInWater: false, yaw: 0 },
    lookAt: async () => {
      lookedAt += 1;
    },
    visibleDigAim: () => null,
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }, { id: "overshot-walk" });
  const result = await executeBotMovement(actuator, step, { end: "continuous" });
  assert.equal(result.kind, "completed");
  assert.equal(lookedAt, 0);
});

test("the Mineflayer actuator accepts a settled landing on partial-height support", async () => {
  const position = { x: 0.01, y: 62.875, z: 0.99 };
  const bot = surface({ entity: { position, onGround: true, isInWater: false } });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("step_up", { x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }, { id: "settled-corner" });
  const result = await executeBotMovement(actuator, step, { end: "settled" });
  assert.equal(result.kind, "completed");
});

test("digging straight down keeps the current yaw and owns its own aim", async () => {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },

    onGround: true,
    isInWater: false,
    climbing: false,
    yaw: 1.23,
    pitch: 0,
  };
  const looks: { yaw: number; pitch: number }[] = [];
  let digForceLook: unknown = "unset";
  let lookedAtCalls = 0;
  const bot = surface({
    entity,
    lookAt: async () => {
      lookedAtCalls += 1;
    },
    look: async (yaw, pitch) => {
      looks.push({ yaw, pitch });
    },
    blockAt: () => ({ name: "stone" }),
    dig: async (_block, forceLook) => {
      digForceLook = forceLook;
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "downward", attempt: 1 },
    new AbortController().signal,
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  // Yaw is meaningless for a block directly below, so it must be carried
  // through rather than recomputed; recomputing it spins the bot every dig.
  assert.deepEqual(looks, [{ yaw: 1.23, pitch: -Math.PI / 2 }]);
  assert.equal(entity.yaw, 1.23);
  // And Mineflayer must not re-aim afterwards, or the fix is undone.
  assert.equal(digForceLook, "ignore");
  assert.equal(lookedAtCalls, 0);
});

test("stationary water controls release after a failed dig and when the search releases its hold", async () => {
  const entity = { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: true, yaw: 0 };
  const controls = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  const bot = surface({
    entity,
    setControlState: (control, state) => {
      controls.set(control, state);
    },
    lookAt: async () => {
      throw new Error("stance correction must preserve the dig aim");
    },
    blockAt: () => ({ name: "obsidian" }),
    dig: async () => {
      entity.position.x = 0.9;
      for (const listener of listeners) listener();
      assert.equal(controls.get("left"), true);
      assert.equal(controls.get("right"), false);
      throw new Error("dig interrupted");
    },
    on: (_event, listener) => {
      listeners.add(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    { kind: "break", position: { x: 1, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "obsidian", attempt: 1 },
    new AbortController().signal,
  );
  assert.equal((await effect.completion).kind, "failed");
  assert.equal(actuator.ownedControlCount, 0);
  assert.equal(listeners.size, 0);
  const release = actuator.holdPosition(new MemoryWorld());
  for (const listener of listeners) listener();
  assert.equal(controls.get("jump"), true);
  release();
  assert.equal(controls.get("jump"), false);
  assert.equal(actuator.ownedControlCount, 0);
  assert.equal(listeners.size, 0);
});

test("a break that brings sand down waits for it to land and breaks it again before completing", async () => {
  // The cell holds sand; the first dig clears it; two ticks later the sand
  // from above lands in it; the second dig clears it for good.
  let cell = "sand";
  let ticksSinceDig = 0;
  let digs = 0;
  const bot = surface({
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false, yaw: 0 },
    waitForTicks: async () => {
      ticksSinceDig += 1;
      if (digs === 1 && ticksSinceDig === 2) cell = "sand";
    },
    blockAt: () => ({ name: cell }),
    dig: async () => {
      digs += 1;
      ticksSinceDig = 0;
      cell = "air";
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    {
      kind: "break",
      position: { x: 1, y: 64, z: 0 },
      expectedStateId: 1,
      toolType: null,
      brings: [{ x: 1, y: 65, z: 0 }],
    },
    { runId: "run", planId: "plan", stepId: "plug", attempt: 1 },
    new AbortController().signal,
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(digs, 2);
  assert.equal(cell, "air");
});

// ── Drops ────────────────────────────────────────────────────────────────────

/**
 * A ledge one block east: pressing forward carries the body 0.2 blocks a tick
 * while it is not sneaking, one tick of coast follows a release, and once the
 * feet pass x 1.2 the body falls a block and lands.
 */
function ledge() {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    isInWater: false,
    climbing: false,
    yaw: 0,
  };
  const held = { forward: false, sneak: true, sprint: false };
  let usedSprint = false;
  let coastTicks = 0;
  let releasedBeforeDescent = false;
  let lookedAt: Position3 | undefined;
  const bot = surface({
    entity,
    setControlState: (control, state) => {
      if (control === "forward") {
        if (!state && entity.position.y === 63) releasedBeforeDescent = true;
        if (!state && held.forward) coastTicks = 1;
      }
      if (control === "sprint") usedSprint ||= state;
      if (control in held) held[control as keyof typeof held] = state;
    },
    waitForTicks: async () => {
      if ((held.forward || coastTicks > 0) && !held.sneak) {
        entity.position.x += 0.2;
        if (!held.forward) coastTicks -= 1;
      }
      if (entity.position.y === 62.85) {
        entity.position.y = 62;
        entity.onGround = true;
      } else if (entity.position.x >= 1.2 && entity.position.y === 63) {
        entity.position.y = 62.85;
        entity.onGround = false;
      }
    },
    lookAt: async (target) => {
      lookedAt = target;
    },
  });
  return {
    actuator: new MineflayerBot(bot, { revision: 1 }),
    entity,
    held,
    landed: () => ({ y: entity.position.y, releasedBeforeDescent, sneaking: held.sneak, usedSprint, lookedAt }),
  };
}

const drop = (validArrivals: Position3[]) =>
  movementStep("drop", { x: 0, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }, { validArrivals, expectedTicks: 6 });

test("a drop keeps moving until the bot is over its lower landing, whether or not an overshoot cell would also do", async () => {
  for (const arrivals of [
    [
      { x: 1, y: 62, z: 0 },
      { x: 2, y: 62, z: 0 },
    ],
    [{ x: 1, y: 62, z: 0 }],
  ]) {
    const { actuator, landed } = ledge();
    const result = await executeBotMovement(actuator, drop(arrivals), { end: "settled" });
    assert.equal(result.kind, "completed");
    const after = landed();
    assert.equal(after.y, 62);
    assert.equal(after.releasedBeforeDescent, true, "forward is released before the descent");
    assert.equal(after.sneaking, false);
    assert.equal(after.usedSprint, false, "a drop never sprints");
    assert.ok(after.lookedAt);
    assert.ok(Math.abs(after.lookedAt.x - 1.33) < 1e-9);
    assert.equal(after.lookedAt.y, 63);
    assert.equal(after.lookedAt.z, 0.5);
  }

  // Already standing on the overshoot cell: that is a valid arrival, and it is reported as the one reached.
  const overshot = surface({ entity: { position: { x: 2.5, y: 62, z: 0.5 }, onGround: true, isInWater: false } });
  const result = await executeBotMovement(
    new MineflayerBot(overshot, { revision: 1 }),
    drop([
      { x: 1, y: 62, z: 0 },
      { x: 2, y: 62, z: 0 },
    ]),
    {
      end: "settled",
    },
  );
  assert.deepEqual(result, { kind: "completed", arrival: { x: 2, y: 62, z: 0 } });
});

test("a descent remains in flight beyond its optimistic route cost", async () => {
  const entity = {
    position: { x: 1.5, y: 63, z: 0.5 },
    velocity: { x: 0, y: -0.1, z: 0 },
    onGround: false,
    isInWater: false,
    climbing: false,
    yaw: 0,
  };
  let ticks = 0;
  const bot = surface({
    entity,
    waitForTicks: async () => {
      ticks += 1;
      entity.position.y -= 0.1;
      if (ticks === 25) {
        entity.position.y = 60;
        entity.onGround = true;
      }
    },
  });
  const step = movementStep("drop", { x: 1, y: 63, z: 0 }, { x: 1, y: 60, z: 0 }, { expectedTicks: 6 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.equal(ticks, 25);
});

// ── Digging straight down ────────────────────────────────────────────────────

/**
 * Move a fake bot the way prismarine-physics would: `forward` accelerates
 * along `(-sin(yaw), -cos(yaw))` and `right` along `(cos(yaw), -sin(yaw))`.
 *
 * Centring has to work through those four controls without rotating, so a
 * double that only understands `forward` cannot tell a working approach from
 * a stalled one.
 */
function applyHeading(position: { x: number; z: number }, held: ReadonlySet<string>, yaw: number): void {
  const ahead = (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0);
  const strafe = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
  position.x += (-ahead * Math.sin(yaw) + strafe * Math.cos(yaw)) * 0.1;
  position.z += (-ahead * Math.cos(yaw) - strafe * Math.sin(yaw)) * 0.1;
}

/** Controls as a set of the ones currently held, kept up to date by `setControlState`. */
function heldControls() {
  const held = new Set<string>();
  const setControlState = (control: string, state: boolean) => {
    if (state) held.add(control);
    else held.delete(control);
  };
  return { held, setControlState };
}

const breakBelow = (actuator: MineflayerBot, stepId: string) =>
  actuator.startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId, attempt: 1 },
    new AbortController().signal,
  );

test("a settled direct-down dig completes without a second movement", async () => {
  let pressedControl = false;
  const bot = surface({
    entity: { position: { x: 0.5, y: 62, z: 0.5 }, onGround: true, isInWater: false },
    setControlState: (_control, state) => {
      pressedControl ||= state;
    },
  });
  const step = movementStep("downward", { x: 0, y: 63, z: 0 }, { x: 0, y: 62, z: 0 }, { expectedTicks: 6 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.deepEqual(result, { kind: "completed", arrival: { x: 0, y: 62, z: 0 } });
  assert.equal(pressedControl, false);
});

test("digging directly beneath the bot centres by strafing, without turning", async () => {
  // Facing -x, so the offset toward the cell centre resolves onto the bot's
  // own back-to-front axis rather than lining up with the world axes.
  const yaw = Math.PI / 2;
  const position = { x: 0.25, y: 63, z: 0.5 };
  const { held, setControlState } = heldControls();
  let looks = 0;
  let dug = false;
  const bot = surface({
    entity: { position, yaw, onGround: true, isInWater: false },
    setControlState,
    waitForTicks: async () => applyHeading(position, held, yaw),
    lookAt: async () => {
      looks += 1;
    },
    look: async () => undefined,
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      assert.ok(Math.abs(position.x - 0.5) <= 0.17);
      assert.ok(Math.abs(position.z - 0.5) <= 0.17);
      dug = true;
    },
  });
  const effect = breakBelow(new MineflayerBot(bot, { revision: 1 }), "downward");

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(dug, true);
  // The whole point: a sub-block approach never derives a heading. Turning to
  // face a point a fifth of a block away picks an arbitrary yaw, and a shaft
  // does it once per block.
  assert.equal(looks, 0);
  assert.equal(held.size, 0);
});

test("direct-down digging proceeds after the centring window and leaves arrival to movement settlement", async () => {
  let centringTicks = 0;
  let dug = false;
  const bot = surface({
    entity: { position: { x: 0.25, y: 63, z: 0.5 }, onGround: true, isInWater: false },
    waitForTicks: async () => {
      centringTicks += 1;
    },
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      dug = true;
    },
  });
  const effect = breakBelow(new MineflayerBot(bot, { revision: 1 }), "downward");

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(centringTicks, 21);
  assert.equal(dug, true);
});

// ── Placing ──────────────────────────────────────────────────────────────────

const placeAt = (actuator: MineflayerBot, position: Position3, support: Position3, stepId: string) =>
  actuator.startEffect(
    { kind: "place", placement: { position, stateId: 1, itemType: 1, support, face: { x: 0, y: 1, z: 0 } } },
    { runId: "run", planId: "plan", stepId, attempt: 1 },
    new AbortController().signal,
  );

test("placing at the bot's feet jumps before issuing the pillar placement", async () => {
  const position = { x: 0.5, y: 63, z: 0.5 };
  let jumping = false;
  let sneaking = false;
  let placed = false;
  const looks: { yaw: number; pitch: number }[] = [];
  const bot = surface({
    entity: { position, onGround: true, isInWater: false, yaw: 2.1 },
    inventory: { items: () => [{ type: 1, count: 1 }] },
    setControlState: (control, state) => {
      if (control === "jump") jumping = state;
      if (control === "sneak") sneaking = state;
    },
    waitForTicks: async () => {
      if (jumping) position.y += 0.2;
    },
    lookAt: async () => {
      throw new Error("a pillar block is directly beneath the feet; its yaw is meaningless and must not be recomputed");
    },
    look: async (yaw, pitch) => {
      looks.push({ yaw, pitch });
    },
    blockAt: () => ({ name: "stone" }),
    placeBlock: async () => {
      assert.equal(position.y > 64.1, true);
      assert.equal(sneaking, true);
      placed = true;
    },
  });
  const effect = placeAt(
    new MineflayerBot(bot, { revision: 1 }),
    { x: 0, y: 63, z: 0 },
    { x: 0, y: 62, z: 0 },
    "pillar",
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(placed, true);
  assert.equal(jumping, false);
  assert.equal(sneaking, false);
  // The head keeps its heading and pitches straight down, as a straight-down dig does.
  assert.deepEqual(looks, [{ yaw: 2.1, pitch: -Math.PI / 2 }]);
});

test("a placement jump that already landed does not start a second pillar jump", async () => {
  let jumped = false;
  const bot = surface({
    entity: { position: { x: 0.5, y: 64, z: 0.5 }, onGround: true, isInWater: false },
    setControlState: (control, state) => {
      if (control === "jump" && state) jumped = true;
    },
    blockAt: () => ({ name: "stone" }),
  });
  const step = movementStep("pillar", { x: 0, y: 63, z: 0 }, { x: 0, y: 64, z: 0 }, { expectedTicks: 12 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.equal(jumped, false);
});

test("placing an adjacent stair tread first moves the bot clear of its cell", async () => {
  const yaw = Math.PI / 2;
  const position = { x: 0.5, y: 63, z: 0.75 };
  const { held, setControlState } = heldControls();
  let placed = false;
  const bot = surface({
    entity: { position, yaw, onGround: true, isInWater: false },
    inventory: { items: () => [{ type: 1, count: 1 }] },
    setControlState,
    waitForTicks: async () => applyHeading(position, held, yaw),
    blockAt: () => ({ name: "stone" }),
    placeBlock: async () => {
      assert.equal(position.z <= 0.67, true);
      placed = true;
    },
  });
  const effect = placeAt(
    new MineflayerBot(bot, { revision: 1 }),
    { x: 0, y: 63, z: 1 },
    { x: 0, y: 62, z: 1 },
    "repair",
  );

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(placed, true);
  assert.equal(held.size, 0);
});

// ── Handing off ──────────────────────────────────────────────────────────────

test("movement steering turns toward the landing and preserves pitch", () => {
  const rotations: { yaw: number; pitch: number; force: boolean | undefined }[] = [];
  const bot = surface({
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, yaw: 0, pitch: 0.4, onGround: false, isInWater: false },
    look: async (yaw, pitch, force) => {
      rotations.push({ yaw, pitch, force });
    },
  });

  new MineflayerBot(bot, { revision: 1 }).applyMovementSteering({ x: 3.5, y: 64, z: 0.5 });

  assert.deepEqual(rotations, [{ yaw: -Math.PI / 2, pitch: 0.4, force: true }]);
});

test("a vertical step-up applies no horizontal input, and a continuous walk hands off on entering the next cell", async () => {
  const vertical = { x: 0.25, y: 63, z: 0.5 };
  let pressedForward = false;
  const climbing = surface({
    entity: { position: vertical, onGround: true, isInWater: false },
    setControlState: (control, state) => {
      if (control === "forward" && state) pressedForward = true;
    },
  });
  const stepUp = movementStep("step_up", { x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }, { target: vertical });
  assert.equal(
    (await executeBotMovement(new MineflayerBot(climbing, { revision: 1 }), stepUp, { end: "settled" })).kind,
    "completed",
  );
  assert.equal(pressedForward, false);

  const walking = { x: 0.5, y: 63, z: 0.5 };
  const walker = surface({
    entity: { position: walking, onGround: true, isInWater: false },
    waitForTicks: async () => {
      walking.x = 1.01;
    },
  });
  const walk = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }, { expectedTicks: 5 });
  assert.equal(
    (await executeBotMovement(new MineflayerBot(walker, { revision: 1 }), walk, { end: "continuous" })).kind,
    "completed",
  );
});


test("a mob entering the scaffold cell while aiming prevents the placement packet", async () => {
  let occupied = false;
  let packets = 0;
  const bot = surface({
    inventory: { items: () => [{ type: 1, count: 1 }] },
    blockAt: () => ({ name: "stone" }),
    lookAt: async () => { occupied = true; },
    placementObstacle: () => occupied ? "Placement cell overlaps enderman #77" : null,
    placeBlock: async () => { packets++; },
  });
  const effect = placeAt(new MineflayerBot(bot, { revision: 1 }),
    { x: 1, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }, "repair");
  assert.deepEqual(await effect.completion, { kind: "failed", observation: "Placement cell overlaps enderman #77" });
  assert.equal(effect.issued, false);
  assert.equal(packets, 0);
});
