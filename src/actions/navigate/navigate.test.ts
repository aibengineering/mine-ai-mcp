import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Navigate, NavigationResult, NavigationRuntime } from "../../navigation/index.js";
import type { MovementPolicy } from "../../navigation/movements/policy.js";
import { ActionRunner } from "../../runner/action-runner.js";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { worldOf, type FakeBlock } from "../../test-support/world.js";
import { createNavigateAction, formatNavigateResult } from "./navigate.js";

const goalTestWorld = new GoalTestWorld();

/**
 * A bot on flat ground whose standing cells are at `groundY` (solid below, air
 * from there up), carrying the scaffold stocks the receipts count. `cells`
 * names any cell that differs from that ground.
 */
function standing(groundY = 64, cells: (cell: Vec3) => FakeBlock | null | undefined = () => undefined) {
  const items: FakeStack[] = [
    { name: "dirt", count: 4 },
    { name: "cobblestone", count: 11 },
  ];
  const ground = worldOf({}, { groundY: groundY - 1 });
  const bot = botFixture(
    { items, blocks: (cell) => cells(cell) ?? ground(cell) },
    {
      game: { dimension: "overworld", gameMode: "survival", minY: -64, height: 384 },
      clearControlStates: () => undefined,
      deactivateItem: () => undefined,
    },
  );
  return { bot, items, cobblestone: items[1]! };
}

/** A cell of `name` whose collision box is `shape`, for the geometry the shared world does not name. */
function cellOf(name: string, cell: Vec3, shape: number[][], properties: Record<string, unknown> = {}): FakeBlock {
  return { name, position: cell, stateId: 0, shapes: shape, boundingBox: shape.length > 0 ? "block" : "empty", getProperties: () => properties };
}

/** The navigation runtime as the action sees it: the route it is handed, and a cancel for body preparation. */
function navigationWith(run: Navigate): NavigationRuntime {
  return { navigate: run, cancel: () => undefined } as unknown as NavigationRuntime;
}

test("dig navigation safely settles partial when its best pickaxe capability drops", async () => {
  const { bot, items } = standing();
  items.push(
    { name: "diamond_pickaxe", count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 1560 },
    { name: "stone_pickaxe", count: 1, slot: 9, maxDurability: 131, durabilityUsed: 0 },
  );
  const run: Navigate = async ({ stopSignal, onToolSelected }) => {
    onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
    items.splice(items.findIndex((item) => item.name === "diamond_pickaxe"), 1);
    bot.inventory.emit("updateSlot", 36, null);
    await Promise.resolve();
    assert.equal(stopSignal?.aborted, true);
    return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: 10, y: 64, z: 0, dig: true });
  assert.equal(output.result.status, "partial");
  assert.match("error" in output.result ? output.result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
});

test("a midwater arrival records current completion without claiming grounded footing", async () => {
  const { bot } = standing(59, (cell) =>
    cell.y >= 59 && cell.y <= 63 ? cellOf("water", cell, [], { level: 0 }) : undefined);
  const action = createNavigateAction(bot, navigationWith(async () => {
    bot.entity.position.set(3.5, 61.2, 0.5);
    bot.entity.onGround = false;
    return { status: "completed", elapsedMs: 1 };
  }));
  const output = await new ActionRunner().run(action, { x: 3, y: 61, z: 0, range: 0 });
  assert.equal(output.result.status, "succeeded");
  assert.equal(output.request?.evidence?.completion.observed, true);
});

test("resumed navigation retains the request origin and stocks and sums only route elapsed time", async () => {
  const { bot, cobblestone } = standing();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const action = createNavigateAction(
    bot,
    navigationWith(async ({ signal }) => {
      attempts++;
      if (attempts === 1) {
        bot.entity.position.set(2.5, 64, 0.5);
        cobblestone.count = 8;
        entered();
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "stopped", reason: "reflex", elapsedMs: 100 };
      }
      bot.entity.position.set(4.5, 64, 0.5);
      cobblestone.count = 6;
      return { status: "completed", elapsedMs: 200 };
    }),
  );
  const runner = new ActionRunner();
  const pending = runner.run(action, { x: 4, y: 64, z: 0, range: 0 });
  await started;
  runner.claim("hunger_reflex", "ate bread", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  const output = await pending;
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.deepEqual(output.result.navigation.start, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(output.result.navigation.elapsedMs, 300);
  assert.deepEqual(
    output.result.navigation.scaffolding.find((stock) => stock.item === "cobblestone"),
    {
      item: "cobblestone",
      inventoryBefore: 11,
      inventoryAfter: 6,
      consumed: 5,
    },
  );
});

test("surface navigation cannot succeed on a cave floor 122 blocks below the target", async () => {
  const { bot } = standing(71);
  bot.entity.position.set(-120, -55, 30);
  const run: Navigate = async ({ goal }) => {
    const resolved = goal.resolve(undefined as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      assert.equal(
        resolved.isSatisfied({ feet: { x: -114, y: -51, z: 8 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
        false,
      );
    }
    bot.entity.position.set(-113.42, -51, 9.49);
    return { status: "completed", elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: -114, z: 8 });
  assert.equal(output.result.status, "failed");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.ok(output.result.navigation.remainingDistance !== null && output.result.navigation.remainingDistance >= 122);
});

test("omitted height refuses a canopy, overhang, or Nether roof instead of choosing its top", async () => {
  for (const roof of ["oak_leaves", "stone", "bedrock"]) {
    const { bot } = standing(64, (cell) => (cell.y === 70 ? cellOf(roof, cell, [[0, 0, 0, 1, 1, 1]]) : undefined));
    if (roof === "bedrock") bot.game.dimension = "the_nether";
    const run: Navigate = async ({ goal }) => {
      const resolved = goal.resolve(undefined as never);
      assert.equal(resolved.kind, "invalid");
      if (resolved.kind !== "invalid") throw new Error("Expected height refusal");
      assert.match(resolved.observation, /NAVIGATION_HEIGHT_REQUIRED.*71, 64/);
      return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
    };
    const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: 3, z: 0 });
    assert.equal(output.result.status, "failed", roof);
    assert.match(output.result.error ?? "", /Supply y/, roof);
  }
});

test("routes without an arbitrary timeout and verifies the final position", async () => {
  const { bot, cobblestone } = standing();
  const run: Navigate = async (options): Promise<NavigationResult> => {
    // A long walk is not a failure: the route runs until it arrives or stops.
    assert.equal("timeoutMs" in options, false);
    cobblestone.count = 0;
    bot.entity.position.set(9.5, 64, 0.5);
    return { status: "completed", elapsedMs: 31_000 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), {
    x: 10,
    y: 64,
    z: 0,
    range: 1,
  });

  assert.equal(output.result.status, "succeeded");
  assert.equal("navigation" in output.result ? output.result.navigation.elapsedMs : null, 31_000);
  assert.equal("navigation" in output.result ? output.result.navigation.remainingDistance : null, 1);
  assert.deepEqual("navigation" in output.result ? output.result.navigation.scaffolding : null, [
    { item: "dirt", inventoryBefore: 4, inventoryAfter: 4, consumed: 0 },
    { item: "cobblestone", inventoryBefore: 11, inventoryAfter: 0, consumed: 11 },
    { item: "cobbled_deepslate", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "netherrack", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "basalt", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
    { item: "end_stone", inventoryBefore: 0, inventoryAfter: 0, consumed: 0 },
  ]);
});

test("the dig and scaffold flags reach the route's movement policy", async () => {
  // The flags are the caller's promise about the terrain: dig false leaves every
  // block standing and scaffold false places none, so the policy the route is
  // handed must refuse both, while the defaults allow both.
  const cases = [
    [{}, true, true],
    [{ scaffold: false, dig: false }, false, false],
  ] as const;
  for (const [flags, digging, placing] of cases) {
    const { bot } = standing();
    let movements: MovementPolicy | undefined;
    const run: Navigate = async (options): Promise<NavigationResult> => {
      movements = options.movements;
      bot.entity.position.set(10.5, 64, 0.5);
      return { status: "completed", elapsedMs: 5 };
    };
    await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: 10, y: 64, z: 0, ...flags });
    assert.equal(movements?.allowDigging, digging, JSON.stringify(flags));
    assert.equal(movements?.allowPlacing, placing, JSON.stringify(flags));
    assert.equal(movements?.scaffold !== null, placing, JSON.stringify(flags));
  }
});

test("uses the same feet-block distance as Pathfinder when verifying completion", async () => {
  const { bot } = standing(-59);
  const run: Navigate = async (): Promise<NavigationResult> => {
    // This is the real regression: entity-centre distance is 2.55, while the
    // final Pathfinder node (2, -59, 8) validly satisfies GoalNear range 2.
    bot.entity.position.set(2.5, -59, 8.5);
    return { status: "completed", elapsedMs: 100 };
  };

  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), {
    x: 0,
    y: -59,
    z: 8,
    range: 2,
  });

  assert.equal(output.result.status, "succeeded");
  assert.equal("navigation" in output.result ? output.result.navigation.remainingDistance : null, 2);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 2.5);
});

test("reports a Pathfinder stop with the observed partial route", async () => {
  const { bot } = standing();
  const run: Navigate = async () => {
    bot.entity.position.set(4, 64, 0);
    return { status: "stopped", reason: "No path to the goal", elapsedMs: 200 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), {
    x: 10,
    y: 64,
    z: 0,
  });

  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /NAVIGATION_STOPPED.*No path/);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 4);
});

test("keeps caller cancellation as a runtime outcome", async () => {
  const { bot } = standing();
  const controller = new AbortController();
  const run: Navigate = async () => {
    controller.abort("stop navigation");
    throw new Error("stop navigation");
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, navigationWith(run)),
    { x: 10, y: 64, z: 0 },
    controller.signal,
  );

  assert.equal(output.result.status, "cancelled");
});

test("an unexpected dimension change on an ordinary route still fails without a cross-world distance", async () => {
  const { bot } = standing();
  const run: Navigate = async () => {
    bot.game.dimension = "the_end";
    bot.entity.position.set(100.5, 49, 0.5);
    return { status: "stopped", reason: "dimension changed to the_end", elapsedMs: 20 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: 10, y: 64, z: 0 });
  assert.equal(output.result.status, "failed");
  assert.ok("navigation" in output.result);
  assert.equal(output.result.navigation.remainingDistance, null);
  assert.match(output.result.error, /NAVIGATION_DIMENSION_CHANGED/);
  assert.match(formatNavigateResult(output.result), /distance to the source-world target does not apply/);
});

test("formats the observed route rather than only its status", () => {
  const markdown = formatNavigateResult({
    status: "succeeded",
    navigation: {
      startDimension: "overworld",
      endDimension: "overworld",
      target: { x: 10, y: 64, z: 0 },
      range: 1,
      start: { x: 0.5, y: 64, z: 0.5 },
      end: { x: 9.5, y: 64, z: 0.5 },
      remainingDistance: Math.sqrt(0.5),
      elapsedMs: 31_000,
      missingDigTools: ["shovel"],
      bucketDrops: { count: 0, waterRecovered: 0 },
      scaffolding: [
        { item: "dirt", inventoryBefore: 4, inventoryAfter: 4, consumed: 0 },
        { item: "cobblestone", inventoryBefore: 11, inventoryAfter: 0, consumed: 11 },
      ],
    },
  });

  assert.match(markdown, /0\.71 blocks/);
  assert.match(markdown, /31000 ms/);
  assert.match(markdown, /cobblestone: 11 → 0 \(used 11\)/);
  assert.match(markdown, /\*\*Warning:\*\* Missing shovel\. Navigation may be slow and inefficient\./);
});

test("omitting y resolves the surface height and measures arrival in three dimensions", async () => {
  const { bot } = standing(71);
  let goalName = "";
  const run: Navigate = async (options): Promise<NavigationResult> => {
    goalName =
      options.goal.resolve(undefined as never).kind === "active"
        ? (options.goal.resolve(undefined as never) as { revision: string }).revision
        : "invalid";
    bot.entity.position.set(10.5, 71, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), { x: 10, z: 0 });

  assert.match(goalName, /^near:/);
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.equal(output.result.navigation.remainingDistance, 0);
});

/** Run one navigate request against a bot, with `run` standing in for the route. */
function runNavigate(bot: ReturnType<typeof standing>["bot"], run: Navigate, request: Record<string, unknown>) {
  return new ActionRunner().run(createNavigateAction(bot, navigationWith(run)), request);
}

test("an explicit target cell is routed to only when the bot could stand there", async () => {
  const solid = [[0, 0, 0, 1, 1, 1]];
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly groundY?: number;
    readonly cells?: (cell: Vec3) => FakeBlock | undefined;
    readonly from?: readonly [number, number, number];
    readonly request: Record<string, unknown>;
    /** Where the fake route leaves the bot when it is asked to run. */
    readonly arrive: readonly [number, number, number];
    readonly routed: boolean;
    readonly check?: (output: Awaited<ReturnType<typeof runNavigate>>) => void;
  }> = [
    {
      // Soul sand is 0.875 tall, so the bot's feet end below the named cell; the
      // exact node receipt must still count that as arriving on it.
      name: "a soul-sand destination is supported and its fractional height satisfies the exact node receipt",
      cells: (cell) => (cell.y === 63 ? cellOf("soul_sand", cell, [[0, 0, 0, 1, 0.875, 1]]) : undefined),
      request: { x: 3, y: 64, z: 0, range: 0 },
      arrive: [3.5, 63.875, 0.5],
      routed: true,
      check: (output) => {
        if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
        assert.equal(output.result.navigation.remainingDistance, 0);
        assert.equal(output.result.navigation.end.y, 63.875);
      },
    },
    {
      // A mid-air y usually means a guessed surface height; building up to it
      // would leave the bot on a pillar it never asked for.
      name: "a mid-air target is refused instead of built up to, and the ground is named",
      request: { x: 120, y: 99, z: -36, range: 2 },
      arrive: [0.5, 64, 0.5],
      routed: false,
      check: (output) => {
        const error = "error" in output.result ? output.result.error : "";
        assert.match(error, /NAVIGATION_TARGET_UNSUPPORTED/);
        assert.match(error, /ground in that column is at y=64/);
        assert.match(error, /Choose an observed supported height/);
        assert.match(error, /build: true/);
      },
    },
    {
      // One block above the ground, right beside the bot: the receipt keeps the
      // height asked for rather than quietly substituting the ground.
      name: "a nearby unsupported explicit height is refused without substituting the ground in its receipt",
      groundY: 62,
      from: [29.5, 62, -46.5],
      request: { x: 29, y: 63, z: -47, range: 0, dig: true, scaffold: true },
      arrive: [29.5, 62, -46.5],
      routed: false,
      check: (output) => {
        const error = "error" in output.result ? output.result.error : "";
        assert.match(error, /NAVIGATION_TARGET_UNSUPPORTED/);
        assert.match(error, /ground in that column is at y=62/);
        if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
        assert.deepEqual(output.result.navigation.target, { x: 29, y: 63, z: -47 });
        assert.equal(output.result.navigation.remainingDistance, 1);
        assert.match(formatNavigateResult(output.result), /Target: `29, 63, -47`/);
      },
    },
    {
      // build: true is the caller saying the pillar is the point.
      name: "build: true accepts a mid-air target on purpose and routes to it",
      request: { x: 120, y: 99, z: -36, range: 2, build: true },
      arrive: [120.5, 99, -35.5],
      routed: true,
    },
    {
      // Solid rock at the target is not a refusal: whether to dig there is the
      // excavation policy's decision, not the target check's.
      name: "a supported target inside solid terrain is left to excavation policy",
      request: { x: 0, y: 60, z: 0, range: 0 },
      arrive: [0.5, 60, 0.5],
      routed: true,
    },
    {
      // The named cell is air, but a ledge within range holds the bot up.
      name: "a target on a ledge within range is a place the bot can be",
      cells: (cell) => (cell.equals(new Vec3(120, 96, -36)) ? cellOf("dirt", cell, solid) : undefined),
      request: { x: 120, y: 98, z: -36, range: 2 },
      arrive: [120.5, 97, -35.5],
      routed: true,
    },
  ];
  for (const { name, groundY, cells, from, request, arrive, routed, check } of cases) {
    const { bot } = standing(groundY, cells);
    if (from) bot.entity.position.set(...from);
    let navigated = false;
    const run: Navigate = async () => {
      navigated = true;
      bot.entity.position.set(...arrive);
      return { status: "completed", elapsedMs: 5 };
    };
    const output = await runNavigate(bot, run, request);
    assert.equal(navigated, routed, name);
    assert.equal(output.result.status, routed ? "succeeded" : "failed", name);
    check?.(output);
  }
});
