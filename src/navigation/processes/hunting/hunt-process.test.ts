import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { botFixture } from "../../../test-support/bot.js";
import type { Goal } from "../../index.js";
import { hunt, type EngagementOutcome, type HuntRequest, type HuntResult, type HuntTarget } from "./hunt-process.js";

/**
 * A bot standing at the origin holding named entities. Every way this loop can
 * misread a route's outcome — walking forever after a mob that keeps its
 * distance, giving up on a species because one of them was behind a fence — is
 * a question a fake answers in a millisecond rather than in a live fixture.
 */
function fakeBot(entities: readonly { id: number; at: Vec3; name?: string }[], feet = new Vec3(0, 64, 0)): Bot {
  return botFixture({
    position: feet,
    entities: Object.fromEntries(
      entities.map((entity) => [entity.id, { id: entity.id, name: entity.name ?? "rabbit", position: entity.at }]),
    ),
  });
}

function request(overrides: Partial<HuntRequest> = {}): HuntRequest {
  return {
    matches: (entity) => entity.name === "rabbit",
    isSatisfied: () => false,
    movements: {} as HuntRequest["movements"],
    contactRange: 8,
    route: async () => ({ status: "completed", elapsedMs: 0 }),
    engage: async () => ({ kind: "defeated" }),
    ...overrides,
  };
}

/** Which entity a route was aimed at, read from the goal the process handed it. */
function aimedAt(bot: Bot, goal: Goal): number {
  const resolved = goal.resolve({
    position: bot.entity.position,
    entities: new Map(
      Object.values(bot.entities).map((entity) => [entity.id, { id: entity.id, position: entity.position }]),
    ),
  } as never);
  assert.equal(resolved.kind, "active");
  if (resolved.kind !== "active") throw new Error("unreachable");
  const id = /^near:\d+:entity:(\d+):/.exec(resolved.revision)?.[1];
  assert.ok(id, `unexpected goal revision ${resolved.revision}`);
  return Number(id);
}

/** A route that puts the bot beside whichever entity it was aimed at. */
function walkingRoute(bot: Bot): HuntRequest["route"] {
  return async (options) => {
    const target = bot.entities[aimedAt(bot, options.goal)]!;
    bot.entity.position.set(target.position.x - 1, target.position.y, target.position.z);
    return { status: "completed", elapsedMs: 0 };
  };
}

for (const presence of ["loaded", "gone", "invalid"] as const) {
  test(`a stopped engagement reports the final ${presence} target observation`, async () => {
    const bot = fakeBot([{ id: 7, at: new Vec3(5, 64, 0) }]);
    bot.entities[7]!.isValid = true;
    const sightings: HuntTarget[] = [];
    const result = await hunt(
      bot,
      request({
        onTargets: (targets) => {
          sightings.push(...targets);
        },
        engage: async () => {
          await Promise.resolve();
          bot.entity.position.set(10, 64, 0);
          bot.entities[7]!.position.set(12, 65, 0);
          if (presence === "gone") delete bot.entities[7];
          if (presence === "invalid") bot.entities[7]!.isValid = false;
          return { kind: "stopped", reason: "guard could not settle" };
        },
      }),
    );
    assert.equal(result.status, "stopped");
    assert.match(result.reason ?? "", presence === "loaded" ? /12,65,0, 2.2 blocks away/ : /5,64,0, 5.0 blocks away/);
    assert.deepEqual(
      sightings.at(-1),
      presence === "loaded"
        ? { id: 7, position: { x: 12, y: 65, z: 0 }, distance: Math.sqrt(5) }
        : { id: 7, position: { x: 5, y: 64, z: 0 }, distance: 5 },
    );
  });
}

test("one kill that satisfies the caller settles the hunt", async () => {
  const bot = fakeBot([{ id: 7, at: new Vec3(65, 64, 0) }]);
  let killed = false;
  const engaged: number[] = [];

  const result = await hunt(
    bot,
    request({
      isSatisfied: () => killed,
      route: walkingRoute(bot),
      engage: async (targetId) => {
        engaged.push(targetId);
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.deepEqual(result, { status: "satisfied", reason: null });
  assert.deepEqual(engaged, [7]);
});

test("nothing left to hunt settles with no targets and no reason, however the quarry went", async () => {
  const nothingMatched = await hunt(fakeBot([{ id: 7, at: new Vec3(3, 64, 0), name: "cow" }]), request());
  assert.deepEqual(nothingMatched, { status: "no_targets", reason: null }, "nothing matching was ever loaded");

  const bot = fakeBot([{ id: 7, at: new Vec3(20, 64, 0) }]);
  const vanished = await hunt(
    bot,
    request({
      route: async () => {
        delete bot.entities[7];
        return { status: "stopped", reason: "Entity 7 is not currently observed.", elapsedMs: 1 };
      },
    }),
  );
  assert.deepEqual(vanished, { status: "no_targets", reason: null }, "a target lost during a route is not unreachable");
});

for (const distance of [4, 40]) {
  test(`resource preflight stops before movement or engagement at distance ${distance}`, async () => {
    const bot = fakeBot([{ id: 7, at: new Vec3(distance, 64, 0) }]);
    const result = await hunt(
      bot,
      request({
        preflight: () => "[COMBAT_BUILD_MATERIALS_MISSING] No usable building blocks remain.",
        route: async () => {
          throw new Error("must not approach before preflight");
        },
        engage: async () => {
          throw new Error("must not engage before preflight");
        },
      }),
    );
    assert.equal(result.status, "capability_blocked");
    assert.match(result.reason ?? "", /COMBAT_BUILD_MATERIALS_MISSING/);
  });
}

test("the announced targets carry every sighting the model needs, nearest first", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(65, 64, 3) },
    { id: 8, at: new Vec3(20, 64, 0) },
    { id: 9, at: new Vec3(300, 64, 0) },
  ]);
  const announcements: (readonly HuntTarget[])[] = [];

  const result = await hunt(
    bot,
    request({
      route: async () => ({ status: "stopped", reason: "no path", elapsedMs: 0 }),
      onTargets: (targets) => {
        announcements.push(targets);
      },
    }),
  );

  assert.deepEqual(
    announcements[0]?.map((target) => ({ ...target, distance: Number(target.distance.toFixed(1)) })),
    [
      { id: 8, position: { x: 20, y: 64, z: 0 }, distance: 20 },
      { id: 7, position: { x: 65, y: 64, z: 3 }, distance: 65.1 },
      // A loaded target is a target however far off it is; the client's own
      // view is the bound, and a hunt that refused what the model can already
      // see would be inventing a smaller world than the one it reports.
      { id: 9, position: { x: 300, y: 64, z: 0 }, distance: 300 },
    ],
  );
  assert.equal(result.status, "unreachable");
});

test("enderman ranking keeps terrain priority inside a nearest-relative band for every candidate order", async () => {
  const candidates = [
    { id: 7, at: new Vec3(8, 64, 0) },
    { id: 8, at: new Vec3(10, 64, 0) },
    { id: 9, at: new Vec3(40, 64, 0) },
  ];
  for (const order of [candidates, [candidates[2]!, candidates[0]!, candidates[1]!], candidates.toReversed()]) {
    const bot = fakeBot(order);
    let killed = false;
    const engaged: number[] = [];
    await hunt(
      bot,
      request({
        reconsiderApproach: true,
        contactRange: 12,
        isSatisfied: () => killed,
        // Replays supported-ground preference: 9 is best, then 8, then 7.
        compareTargets: (left, right) => right.id - left.id,
        engage: async (id) => {
          engaged.push(id);
          killed = true;
          return { kind: "defeated" };
        },
      }),
    );
    assert.deepEqual(engaged, [8]);
  }
});

test("the nearest-relative band never promotes an explicit hazard tier", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(3, 64, 0) },
    { id: 8, at: new Vec3(40, 64, 0) },
  ]);
  let killed = false;
  const engaged: number[] = [];
  await hunt(
    bot,
    request({
      reconsiderApproach: true,
      contactRange: 50,
      isSatisfied: () => killed,
      targetTier: (entity) => (entity.id === 7 ? 1 : 0),
      engage: async (id) => {
        engaged.push(id);
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );
  assert.deepEqual(engaged, [8]);
});

test("a target the pursuit cannot finish is given up on, and the next loaded one is hunted", async () => {
  const rows: {
    readonly name: string;
    readonly firstAt: Vec3;
    readonly stopsRoute?: boolean;
    readonly firstEngagement?: EngagementOutcome;
    readonly attempts: string[];
  }[] = [
    {
      name: "a route that stops",
      firstAt: new Vec3(20, 64, 0),
      stopsRoute: true,
      attempts: ["route:7", "route:8", "engage:8"],
    },
    {
      name: "a fight that cannot reach its target",
      firstAt: new Vec3(5, 64, 0),
      firstEngagement: { kind: "unreachable", reason: "Combat approach stopped: radius limit 32 reached" },
      attempts: ["engage:7", "route:8", "engage:8"],
    },
    {
      name: "a target lost to someone else's kill",
      firstAt: new Vec3(5, 64, 0),
      firstEngagement: { kind: "target_lost" },
      attempts: ["engage:7", "route:8", "engage:8"],
    },
  ];

  for (const row of rows) {
    const bot = fakeBot([
      { id: 7, at: row.firstAt },
      { id: 8, at: new Vec3(40, 64, 0) },
    ]);
    const walk = walkingRoute(bot);
    const attempts: string[] = [];
    let killed = false;

    const result = await hunt(
      bot,
      request({
        isSatisfied: () => killed,
        route: async (options) => {
          const id = aimedAt(bot, options.goal);
          attempts.push(`route:${id}`);
          if (row.stopsRoute && id === 7)
            return { status: "stopped", reason: "no path; closest node was 12,64,0", elapsedMs: 0 };
          return walk(options);
        },
        engage: async (targetId) => {
          attempts.push(`engage:${targetId}`);
          if (targetId === 7 && row.firstEngagement) return row.firstEngagement;
          killed = true;
          return { kind: "defeated" };
        },
      }),
    );

    assert.equal(result.status, "satisfied", row.name);
    assert.deepEqual(attempts, row.attempts, row.name);
  }
});

test("a second stop on the same target is final, and the reason names its last sighting", async () => {
  const rows: {
    readonly name: string;
    readonly at: Vec3;
    readonly route?: HuntRequest["route"];
    readonly engage?: HuntRequest["engage"];
    readonly attempts: number;
    readonly result: HuntResult;
  }[] = [
    {
      name: "a fight that ends without a verdict stops the hunt where the target stood",
      at: new Vec3(4, 64, 0),
      engage: async () => ({ kind: "stopped", reason: "the bot is too hurt to start this fight" }),
      attempts: 1,
      result: {
        status: "stopped",
        reason: "the bot is too hurt to start this fight; the target was last observed at 4,64,0, 4.0 blocks away",
      },
    },
    {
      name: "two unreachable fights with the same target",
      at: new Vec3(5, 64, 0),
      engage: async () => ({ kind: "unreachable", reason: "Combat approach stopped: radius limit 32 reached" }),
      attempts: 2,
      result: {
        status: "unreachable",
        reason:
          "Combat approach stopped: radius limit 32 reached; the target was last observed at 5,64,0, 5.0 blocks away",
      },
    },
    {
      name: "two stopped routes on the same target",
      at: new Vec3(65, 64, 3),
      route: async () => ({ status: "stopped", reason: "no path; closest node was 12,64,0", elapsedMs: 0 }),
      attempts: 2,
      result: {
        status: "unreachable",
        reason: "no path; closest node was 12,64,0; the target was last observed at 65,64,3, 65.1 blocks away",
      },
    },
  ];

  for (const row of rows) {
    const bot = fakeBot([{ id: 7, at: row.at }]);
    const selected: number[] = [];
    let attempts = 0;

    const result = await hunt(
      bot,
      request({
        onTargetChanged: ({ selected: target }) => {
          selected.push(target.id);
        },
        route: async (options) => {
          attempts += 1;
          if (!row.route) throw new Error("a target already inside contact range must not be walked to");
          return row.route(options);
        },
        engage: async (targetId) => {
          attempts += 1;
          if (!row.engage) throw new Error("the fight must not be reached from outside contact range");
          return row.engage(targetId);
        },
      }),
    );

    assert.equal(attempts, row.attempts, row.name);
    assert.deepEqual(selected, [7], `${row.name}: same-target retries are not retargets`);
    assert.deepEqual(result, row.result, row.name);
  }
});

test("a target that keeps its distance ends the pursuit instead of walking forever", async () => {
  const fleeing = new Vec3(40, 64, 0);
  const bot = fakeBot([{ id: 7, at: fleeing }]);
  let routes = 0;

  const result = await hunt(
    bot,
    request({
      route: async () => {
        routes += 1;
        // The bot closes ten blocks and the rabbit runs ten more: a route that
        // completes without ever arriving.
        bot.entity.position.translate(10, 0, 0);
        fleeing.translate(10, 0, 0);
        return { status: "completed", elapsedMs: 0 };
      },
      engage: async () => {
        throw new Error("the fight must not be reached from outside contact range");
      },
    }),
  );

  assert.ok(routes <= 4, `expected the pursuit to end quickly, ran ${routes} routes`);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason ?? "", /route completed without closing.*40\.0 blocks away/);
});

test("an approach switches to a substantially closer quarry on its bounded reconsideration tick", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(20, 64, 0) },
    { id: 8, at: new Vec3(30, 64, 0) },
  ]);
  const changes: { id: number; reason: string }[] = [];
  let killed = false;

  const result = await hunt(
    bot,
    request({
      reconsiderApproach: true,
      isSatisfied: () => killed,
      onTargetChanged: ({ selected, reason }) => changes.push({ id: selected.id, reason }),
      route: async (options) => {
        const id = aimedAt(bot, options.goal);
        if (id === 7) {
          bot.entities[8]!.position.set(6, 64, 0);
          for (let tick = 0; tick < 20; tick++) bot.emit("physicsTick");
          assert.equal(options.stopSignal?.aborted, true);
          return { status: "stopped", reason: String(options.stopSignal?.reason), elapsedMs: 1 };
        }
        return walkingRoute(bot)(options);
      },
      engage: async (id) => {
        assert.equal(id, 8);
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(changes, [
    { id: 7, reason: "Initial target selection." },
    { id: 8, reason: "closer target during approach" },
  ]);
});

test("reconsideration sees a closer alternative through one retained approach stop", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(20, 64, 0) },
    { id: 8, at: new Vec3(5, 64, 0) },
  ]);
  const engaged: number[] = [];
  let killed = false;

  await hunt(
    bot,
    request({
      reconsiderApproach: true,
      isSatisfied: () => killed,
      route: async (options) => {
        const id = aimedAt(bot, options.goal);
        if (id === 7) {
          bot.entities[8]!.position.set(2, 64, 0);
          for (let tick = 0; tick < 20; tick++) bot.emit("physicsTick");
          assert.equal(options.stopSignal?.aborted, true);
          return { status: "stopped", reason: String(options.stopSignal?.reason), elapsedMs: 1 };
        }
        return walkingRoute(bot)(options);
      },
      engage: async (id) => {
        engaged.push(id);
        if (engaged.length === 1) return { kind: "unreachable", reason: "first approach failed" };
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.deepEqual(engaged, [8, 8]);
});

test("reconsideration cannot replace a safe target with a closer hazardous target", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(20, 64, 0) },
    { id: 8, at: new Vec3(30, 64, 0) },
  ]);
  const selected: number[] = [];
  let killed = false;

  await hunt(
    bot,
    request({
      reconsiderApproach: true,
      targetTier: (target) => (target.id === 8 ? 1 : 0),
      isSatisfied: () => killed,
      onTargetChanged: ({ selected: target }) => selected.push(target.id),
      route: async (options) => {
        bot.entities[8]!.position.set(4, 64, 0);
        for (let tick = 0; tick < 20; tick++) bot.emit("physicsTick");
        assert.equal(options.stopSignal?.aborted, false);
        return walkingRoute(bot)(options);
      },
      engage: async (id) => {
        assert.equal(id, 7);
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.deepEqual(selected, [7]);
});

test("a selected-target teleport stops its route and reports the distinct retarget reason", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(20, 64, 0) },
    { id: 8, at: new Vec3(25, 64, 0) },
  ]);
  const changes: { id: number; reason: string }[] = [];
  let killed = false;

  await hunt(
    bot,
    request({
      reconsiderApproach: true,
      isSatisfied: () => killed,
      onTargetChanged: ({ selected, reason }) => changes.push({ id: selected.id, reason }),
      route: async (options) => {
        if (aimedAt(bot, options.goal) === 7) {
          bot.entities[7]!.position.set(48, 64, 0);
          bot.emit("entityMoved", bot.entities[7]!);
          assert.equal(options.stopSignal?.aborted, true);
          return { status: "stopped", reason: String(options.stopSignal?.reason), elapsedMs: 1 };
        }
        return walkingRoute(bot)(options);
      },
      engage: async () => {
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.deepEqual(changes.at(-1), { id: 8, reason: "selected target teleported" });
});

test("small distance improvements do not thrash an active approach", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(9, 64, 0) },
    { id: 8, at: new Vec3(10, 64, 0) },
  ]);
  const selected: number[] = [];
  let killed = false;

  await hunt(
    bot,
    request({
      reconsiderApproach: true,
      isSatisfied: () => killed,
      onTargetChanged: ({ selected: target }) => selected.push(target.id),
      route: async (options) => {
        bot.entities[8]!.position.set(-8, 64, 0);
        for (let tick = 0; tick < 20; tick++) bot.emit("physicsTick");
        assert.equal(options.stopSignal?.aborted, false);
        return walkingRoute(bot)(options);
      },
      engage: async () => {
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.deepEqual(selected, [7]);
});

test("one failed approach stops penalizing nearby quarry after it materially moves", async () => {
  const bot = fakeBot([
    { id: 7, at: new Vec3(5, 64, 0) },
    { id: 8, at: new Vec3(40, 64, 0) },
  ]);
  const engaged: number[] = [];
  let killed = false;

  const result = await hunt(
    bot,
    request({
      contactRange: 12,
      isSatisfied: () => killed,
      engage: async (id) => {
        engaged.push(id);
        if (engaged.length === 1) {
          bot.entities[id]!.position.translate(5, 0, 0);
          return { kind: "unreachable", reason: "target teleported onto the canopy" };
        }
        killed = true;
        return { kind: "defeated" };
      },
    }),
  );

  assert.equal(result.status, "satisfied");
  assert.deepEqual(engaged, [7, 7]);
});
