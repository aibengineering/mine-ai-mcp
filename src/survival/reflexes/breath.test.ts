import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigateOptions, NavigationResult, NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { registry } from "../../test-support/bot.js";
import { waterFixture } from "../../test-support/water.js";
import { type SurvivalTransition } from "../control/contract.js";
import { attachBreathReflex } from "./breath.js";

type BreathNavigation = Pick<NavigationRuntime, "navigate" | "world" | "diveBackstop">;
const water = { name: "water", boundingBox: "empty", shapes: [] };
const air = { name: "air", boundingBox: "empty", shapes: [] };
const obsidian = { name: "obsidian", boundingBox: "block", diggable: true, shapes: [[0, 0, 0, 1, 1, 1]] };

/** Open water up to two blocks over the body: rising alone reaches air. */
function openWater(bot: { entity: { position: Vec3 } }) {
  return (p: Vec3) => (p.y < Math.floor(bot.entity.position.y) + 2 ? water : air);
}

/** Water under an obsidian ceiling just above the head: only a route reaches air. */
function sealedWater(bot: { entity: { position: Vec3 } }) {
  return (p: Vec3) => (p.y < Math.floor(bot.entity.position.y) + 2 ? water : obsidian);
}

/**
 * Navigation's view of the same water, read through `bot.blockAt`'s names so
 * the two always agree: a test that opens the ceiling opens it for both.
 */
function worldOf(bot: { blockAt: (p: Vec3) => { name: string } | null }) {
  const memory = new MemoryWorld();
  const kinds = {
    water: { stateId: 2, traits: { empty: true, liquid: "water" as const, liquidSource: true } },
    air: { stateId: 0 },
    obsidian: { stateId: 1 },
  };
  return {
    subscribe: () => () => {},
    blockAt(x: number, y: number, z: number) {
      const name = bot.blockAt(new Vec3(x, y, z))?.name ?? "air";
      memory.load({ x, y, z }, kinds[name as keyof typeof kinds] ?? kinds.obsidian);
      return memory.blockAt(x, y, z);
    },
  };
}

/** A navigation runtime whose routes the test answers. */
function navigation(
  bot: { blockAt: (p: Vec3) => { name: string } | null },
  navigate: (options: NavigateOptions) => Promise<NavigationResult> = async () => ({
    status: "stopped",
    reason: "no route",
    elapsedMs: 0,
  }),
  diveBackstop: () => number | null = () => null,
): BreathNavigation {
  return { navigate, diveBackstop, world: worldOf(bot) } as unknown as BreathNavigation;
}

/** The real block registry, so a route's movement policy can be built, keeping the fixture's air key. */
function withBlockRegistry(bot: object): void {
  Object.assign(bot, {
    registry: Object.assign(Object.create(registry), {
      entitiesByName: { player: { metadataKeys: ["air_supply"] } },
    }),
    game: { dimension: "overworld" },
  });
}

/** A bot under PocketSwimmer's ceiling with eight points of air. */
function sealedDiver(t: Parameters<typeof waterFixture>[0]) {
  const fixture = waterFixture(t);
  withBlockRegistry(fixture.bot);
  Object.assign(fixture.entity, { isInWater: true, position: new Vec3(0.5, -58, 0.5) });
  Object.assign(fixture.bot, { oxygenLevel: 8, health: 20, username: "Diver", blockAt: sealedWater(fixture.bot) });
  return fixture;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an owned dive uses its escape floor and preserves the failed budget after ownership transfers", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 10, health: 20, username: "Diver", blockAt: openWater(fixture.bot) });
  fixture.entity.isInWater = true;
  let floor: number | null = 70;
  const outcomes: SurvivalTransition[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "outcome") outcomes.push(event); });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, navigation(fixture.bot, undefined, () => floor));
  for (let tick = 0; tick < 10; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  fixture.bot.oxygenLevel = 4;
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  floor = null;
  // Navigation releases its declaration on takeover. Further sensing must not
  // turn this failed planned dive into an ordinary resumable breath response.
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  fixture.bot.oxygenLevel = 20;
  fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(JSON.parse(JSON.stringify(outcomes[0]?.evidence)).outcome.ownedDive, true);
  await control[Symbol.asyncDispose]();
});

test("missing own air cannot claim the body using stale oxygenLevel", async (t) => {
  const fixture = waterFixture(t);
  Object.defineProperty(fixture.bot, "oxygenLevel", { value: -1 });
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex, navigation(fixture.bot));
  for (let tick = 0; tick < 10; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  await control[Symbol.asyncDispose]();
});

test("closing a breath takeover releases it even after physics stops", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 8, health: 20, username: "Diver", blockAt: openWater(fixture.bot) });
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex, navigation(fixture.bot));
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  await control[Symbol.asyncDispose]();
  assert.equal(fixture.reflex.runner.status().owner, "idle");
});

test("lost own-air metadata ends surfacing without resuming the interrupted action", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 8, health: 20, username: "Diver", blockAt: openWater(fixture.bot) });
  fixture.entity.isInWater = true;
  let decision: Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }> | undefined;
  const runner = fixture.reflex.runner;
  const claim = runner.claim;
  Object.assign(runner, {
    claim: (
      _owner: string,
      _description: string,
      work: (
        signal: AbortSignal,
      ) => Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }>,
    ) => {
      return claim(_owner, _description, (signal) => {
        decision = work(signal);
        return decision;
      });
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, navigation(fixture.bot));
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  Object.assign(fixture.bot.entity, { metadata: [] });
  fixture.bot.emit("physicsTick");
  assert.ok(decision);
  assert.notEqual((await decision).continuation.kind, "resume");
  await control[Symbol.asyncDispose]();
});

test("close cancels a route to air and waits for it to settle", async (t) => {
  const fixture = sealedDiver(t);
  let announceRoute!: () => void;
  const started = new Promise<void>((resolve) => {
    announceRoute = resolve;
  });
  let release!: () => void;
  const control = attachBreathReflex(
    fixture.bot,
    fixture.reflex,
    navigation(
      fixture.bot,
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          announceRoute();
          signal!.addEventListener("abort", () => {
            release = () => reject(signal!.reason);
          });
        }),
    ),
  );
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  await started;
  let closed = false;
  const closing = control[Symbol.asyncDispose]().then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false, "shutdown must wait for the route to release the body");
  release();
  await closing;
  const writesAtClose = fixture.controls.length;
  fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, writesAtClose);
  assert.deepEqual(fixture.controls.filter(([control]) => control === "jump").at(-1), ["jump", false]);
});

test("under a ceiling it routes to air on a budget of its air and health, then holds the surface", async (t) => {
  const fixture = sealedDiver(t);
  const routes: NavigateOptions[] = [];
  const outcomes: SurvivalTransition[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "outcome") outcomes.push(event); });
  const control = attachBreathReflex(
    fixture.bot,
    fixture.reflex,
    navigation(fixture.bot, async (options) => {
      routes.push(options);
      // Arrive in the pocket: the column over the body is open now.
      fixture.bot.blockAt = openWater(fixture.bot) as never;
      return { status: "completed", elapsedMs: 0 };
    }),
  );
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(routes.length, 1);
  // 8 points of air is 120 ticks, then 20 health at ten ticks each, less a
  // 20-tick margin for the estimates.
  assert.deepEqual(routes[0]!.movements.dive, { origin: new Vec3(0.5, -58, 0.5), airTicks: 300, ascent: "goal" });
  assert.equal(routes[0]!.searchLimits?.maximumRadius, 16);
  fixture.bot.emit("physicsTick");
  await settle();
  assert.deepEqual(fixture.controls.filter(([control]) => control === "jump").at(-1), ["jump", true]);
  fixture.bot.oxygenLevel = 20;
  fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(JSON.parse(JSON.stringify(outcomes[0]?.evidence)).outcome.kind, "air_full");
  await control[Symbol.asyncDispose]();
});

test("with no route to air the body goes back at once, and the same ceiling is not asked again", async (t) => {
  const fixture = sealedDiver(t);
  const outcomes: SurvivalTransition[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "outcome") outcomes.push(event); });
  let routes = 0;
  const control = attachBreathReflex(
    fixture.bot,
    fixture.reflex,
    navigation(fixture.bot, async () => {
      routes++;
      return { status: "stopped", reason: "No path to head-out-of-liquid", elapsedMs: 0 };
    }),
  );
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  await settle();
  await settle();
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  const outcome = JSON.parse(JSON.stringify(outcomes[0]?.evidence)).outcome;
  assert.equal(outcome.kind, "stuck");
  assert.deepEqual(outcome.routes, [{ budgetTicks: 300, status: "stopped", reason: "No path to head-out-of-liquid" }]);
  for (let tick = 0; tick < 20; tick += 1) fixture.bot.emit("physicsTick");
  await settle();
  assert.equal(routes, 1);
  await control[Symbol.asyncDispose]();
});

test("claims the body at half air and records the surfacing", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.entity, { position: new Vec3(0.5, -59, 0.5) });
  Object.assign(fixture.bot, {
    oxygenLevel: 8,
    health: 20,
    username: "Diver",
    blockAt: openWater(fixture.bot),
  });
  const recorded: SurvivalTransition[] = [];
  fixture.reflex.onTransition((transition) => {
    if (transition.kind === "outcome") recorded.push(transition);
  });
  const claims: string[] = [];
  let outcome: Promise<unknown> | null = null;
  const runner = fixture.reflex.runner;
  const claim = runner.claim;
  Object.assign(runner, {
    claim: (
      owner: string,
      description: string,
      work: (
        signal: AbortSignal,
      ) => Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }>,
    ) => {
      claims.push(`${owner} ${description}`);
      const admission = claim(owner, description, work);
      if (admission.kind === "claimed") outcome = admission.outcome;
      return admission;
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, navigation(fixture.bot));

  fixture.entity.isInWater = true;
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  assert.deepEqual(claims, ["breath_reflex [BREATH] surface at air 8."]);
  Object.assign(fixture.bot, { oxygenLevel: 20 });
  fixture.bot.emit("physicsTick");
  await outcome;
  await settle();

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.reflex, "breath_reflex");
  assert.equal(JSON.parse(JSON.stringify(recorded[0]?.evidence)).outcome.airAfter, 20);
  const jumps = fixture.controls.filter(([control]) => control === "jump");
  assert.deepEqual(jumps[0], ["jump", true]);
  assert.deepEqual(jumps.at(-1), ["jump", false]);
  assert.equal(jumps.filter(([, state]) => !state).length, 1, "it rises until it lets go");

  await control[Symbol.asyncDispose]();
});
