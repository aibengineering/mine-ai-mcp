import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, type NavigationResult } from "../../navigation/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { ActionRunner } from "../../session/action-runner.js";
import { parseNavigateRequest } from "./contract.js";
import { createNavigateAction, formatNavigateResult, type NavigateDependencies } from "./navigate.js";
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";

const goalTestWorld = new GoalTestWorld();

/** A bot on flat ground whose standing cells are at `groundY`: solid below, air from there up. */
function botFixture(groundY = 64) {
  const inventory = new Map<string, number>([
    ["dirt", 4],
    ["cobblestone", 11],
  ]);
  const bot = {
    blockAt: (cell: Vec3) =>
      cell.y < groundY
        ? { name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
        : { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) },
    entity: { position: new Vec3(0.5, 64, 0.5), vehicle: null },
    game: { dimension: "overworld", minY: -64, height: 384 },
    pathfinder: { movements: {}, setGoal: () => {} },
    clearControlStates: () => {},
    deactivateItem: () => {},
    currentWindow: null,
    isSleeping: false,
    dismount: () => {},
    wake: async () => {},
    registry: {
      itemsByName: {
        dirt: { id: 1 },
        cobblestone: { id: 2 },
      },
    },
    inventory: {
      items: () => [...inventory].map(([name, count]) => ({ name, count })),
      count: (itemId: number) => inventory.get(itemId === 1 ? "dirt" : itemId === 2 ? "cobblestone" : "") ?? 0,
    },
  } as unknown as Bot;
  return { bot, inventory };
}

function dependencies(
  run: NavigateDependencies["navigate"],
  movementOptions: unknown[] = [],
): NavigateDependencies {
  return {
    createMovements: ((_bot: Bot, options: unknown) => {
      movementOptions.push(options);
      return { name: "standard" };
    }) as unknown as typeof createMovements,
    navigate: run,
  };
}

const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;

test("dig navigation safely settles partial when its best pickaxe capability drops", async () => {
  const { bot } = botFixture();
  const items = [
    { name: "diamond_pickaxe", count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 1560 },
    { name: "stone_pickaxe", count: 1, slot: 9, maxDurability: 131, durabilityUsed: 0 },
  ];
  bot.registry = minecraftData("1.21.4") as never;
  const inventoryEvents = Object.assign(new EventEmitter(), { items: () => items, count: () => 0 });
  bot.inventory = inventoryEvents as never;
  const run: NavigateDependencies["navigate"] = async ({ stopSignal, onToolSelected }) => {
    onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
    items.shift();
    inventoryEvents.emit("updateSlot", 36, null);
    await Promise.resolve();
    assert.equal(stopSignal?.aborted, true);
    return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 1 };
  };
  const deps: NavigateDependencies = { navigate: run, createMovements: (() => createMovementPolicy({
    priceBreak: () => ({ decision: { kind: "allowed" },
      tool: { itemType: bot.registry.itemsByName.diamond_pickaxe!.id, expectedTicks: 1 } }),
  })) as never };
  const action = createNavigateAction(bot, fakeNavigation, deps);
  const output = await new ActionRunner().run(action, { x: 10, y: 64, z: 0, dig: true });
  assert.equal(output.result.status, "partial");
  assert.match("error" in output.result ? output.result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
});

test("a midwater arrival records current completion without claiming grounded footing", async () => {
  const { bot } = botFixture(59);
  const dry = bot.blockAt;
  bot.blockAt = ((cell: Vec3) => cell.y >= 59 && cell.y <= 63
    ? { name: "water", boundingBox: "empty", shapes: [], getProperties: () => ({ level: 0 }) }
    : dry(cell)) as Bot["blockAt"];
  const action = createNavigateAction(bot, fakeNavigation, dependencies(async () => {
    bot.entity.position.set(3.5, 61.2, 0.5);
    bot.entity.onGround = false;
    return { status: "completed", elapsedMs: 1 };
  }));
  const output = await new ActionRunner().run(action, { x: 3, y: 61, z: 0, range: 0 });
  assert.equal(output.result.status, "succeeded");
  assert.equal(output.request?.evidence?.completion.observed, true);
});

test("resumed navigation retains the request origin and stocks and sums only route elapsed time", async () => {
  const { bot, inventory } = botFixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const action = createNavigateAction(
    bot,
    fakeNavigation,
    dependencies(async ({ signal }) => {
      attempts++;
      if (attempts === 1) {
        bot.entity.position.set(2.5, 64, 0.5);
        inventory.set("cobblestone", 8);
        entered();
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "stopped", reason: "reflex", elapsedMs: 100 };
      }
      bot.entity.position.set(4.5, 64, 0.5);
      inventory.set("cobblestone", 6);
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

test("a soul-sand destination is supported and its fractional physical height satisfies the exact node receipt", async () => {
  const { bot } = botFixture();
  const blockAt = bot.blockAt;
  bot.blockAt = ((cell: Vec3) =>
    cell.y === 63
      ? { name: "soul_sand", boundingBox: "block", shapes: [[0, 0, 0, 1, 0.875, 1]], getProperties: () => ({}) }
      : blockAt(cell)) as Bot["blockAt"];
  const run: NavigateDependencies["navigate"] = async () => {
    bot.entity.position.set(3.5, 63.875, 0.5);
    bot.entity.onGround = true;
    return { status: "completed", elapsedMs: 1 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 3, y: 64, z: 0, range: 0 },
  );
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.remainingDistance, 0);
  assert.equal(output.result.navigation.end.y, 63.875);
});

test("surface navigation cannot succeed on a cave floor 122 blocks below the target", async () => {
  const { bot } = botFixture(71);
  bot.entity.position.set(-120, -55, 30);
  const run: NavigateDependencies["navigate"] = async ({ goal }) => {
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
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: -114, z: 8 },
  );
  assert.equal(output.result.status, "failed");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.ok(output.result.navigation.remainingDistance !== null && output.result.navigation.remainingDistance >= 122);
});

test("omitted height refuses a canopy, overhang, or Nether roof instead of choosing its top", async () => {
  for (const roof of ["oak_leaves", "stone", "bedrock"]) {
    const { bot } = botFixture(64);
    const blockAt = bot.blockAt;
    bot.blockAt = ((cell: Vec3) =>
      cell.y === 70
        ? { name: roof, boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
        : blockAt(cell)) as Bot["blockAt"];
    if (roof === "bedrock") bot.game.dimension = "the_nether";
    const run: NavigateDependencies["navigate"] = async ({ goal }) => {
      const resolved = goal.resolve(undefined as never);
      assert.equal(resolved.kind, "invalid");
      if (resolved.kind !== "invalid") throw new Error("Expected height refusal");
      assert.match(resolved.observation, /NAVIGATION_HEIGHT_REQUIRED.*71, 64/);
      return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
    };
    const output = await new ActionRunner().run(
      createNavigateAction(bot, fakeNavigation, dependencies(run)),
      { x: 3, z: 0 },
    );
    assert.equal(output.result.status, "failed");
    assert.match(output.result.error ?? "", /Supply y/);
  }
});

test("parses one absolute destination and defaults its reached range", () => {
  assert.deepEqual(parseNavigateRequest({ x: 12, y: 65, z: -4 }), {
    x: 12,
    y: 65,
    z: -4,
    range: 1,
    scaffold: true,
    dig: true,
    build: false,
  });
  assert.deepEqual(parseNavigateRequest({ x: 12, z: -4, scaffold: false, dig: false }), {
    x: 12,
    y: null,
    z: -4,
    range: 1,
    scaffold: false,
    dig: false,
    build: false,
  });
  for (const input of [
    {},
    { x: 1, y: 2 },
    { x: 1.5, y: 2, z: 3 },
    { x: 1, y: 2, z: 3, range: -1 },
    { x: 1, y: 2, z: 3, mode: "safe" },
    { x: 1, y: 2, z: 3, dig: "false" },
    { x: 1, y: 2, z: 3, combat: "off" },
  ]) {
    assert.throws(() => parseNavigateRequest(input));
  }
});

test("uses standard movements without an arbitrary route timeout and verifies the final position", async () => {
  const { bot, inventory } = botFixture();
  const run: NavigateDependencies["navigate"] = async (options): Promise<NavigationResult> => {
    assert.equal("timeoutMs" in options, false);
    assert.equal(Reflect.get(options.movements, "name"), "standard");
    inventory.set("cobblestone", 0);
    bot.entity.position.set(9.5, 64, 0.5);
    return { status: "completed", elapsedMs: 31_000 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 10,
      y: 64,
      z: 0,
      range: 1,
    },
  );

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

test("uses the same feet-block distance as Pathfinder when verifying completion", async () => {
  const { bot } = botFixture(-59);
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    // This is the real regression: entity-centre distance is 2.55, while the
    // final Pathfinder node (2, -59, 8) validly satisfies GoalNear range 2.
    bot.entity.position.set(2.5, -59, 8.5);
    return { status: "completed", elapsedMs: 100 };
  };

  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 0,
      y: -59,
      z: 8,
      range: 2,
    },
  );

  assert.equal(output.result.status, "succeeded");
  assert.equal("navigation" in output.result ? output.result.navigation.remainingDistance : null, 2);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 2.5);
});

test("reports a Pathfinder stop with the observed partial route", async () => {
  const { bot } = botFixture();
  const run: NavigateDependencies["navigate"] = async (routeBot) => {
    bot.entity.position.set(4, 64, 0);
    return { status: "stopped", reason: "No path to the goal", elapsedMs: 200 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    {
      x: 10,
      y: 64,
      z: 0,
    },
  );

  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /NAVIGATION_STOPPED.*No path/);
  assert.equal("navigation" in output.result ? output.result.navigation.end.x : null, 4);
});

test("keeps caller cancellation as a runtime outcome", async () => {
  const { bot } = botFixture();
  const controller = new AbortController();
  const run: NavigateDependencies["navigate"] = async () => {
    controller.abort("stop navigation");
    throw new Error("stop navigation");
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, y: 64, z: 0 },
    controller.signal,
  );

  assert.equal(output.result.status, "cancelled");
});

test("an unexpected dimension change on an ordinary route still fails without a cross-world distance", async () => {
  const { bot } = botFixture();
  const run: NavigateDependencies["navigate"] = async () => {
    bot.game.dimension = "the_end";
    bot.entity.position.set(100.5, 49, 0.5);
    return { status: "stopped", reason: "dimension changed to the_end", elapsedMs: 20 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, y: 64, z: 0 },
  );
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
  const { bot } = botFixture(71);
  let goalName = "";
  const run: NavigateDependencies["navigate"] = async (options): Promise<NavigationResult> => {
    goalName =
      options.goal.resolve(undefined as never).kind === "active"
        ? (options.goal.resolve(undefined as never) as { revision: string }).revision
        : "invalid";
    bot.entity.position.set(10.5, 71, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 10, z: 0 },
  );

  assert.match(goalName, /^near:/);
  assert.equal(output.result.status, "succeeded");
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.equal(output.result.navigation.target.y, 71);
  assert.equal(output.result.navigation.remainingDistance, 0);
});

test("dig=false and scaffold=false reach the movement policy", async () => {
  const { bot } = botFixture();
  const movementOptions: unknown[] = [];
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    bot.entity.position.set(10.5, 64, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run, movementOptions)),
    { x: 10, y: 64, z: 0, scaffold: false, dig: false },
  );

  assert.deepEqual(movementOptions, [{ scaffolding: false, allowDigging: false }]);
});

test("refuses a mid-air target instead of building up to it, and names the ground", async () => {
  const { bot } = botFixture();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    navigated = true;
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 99, z: -36, range: 2 },
  );

  assert.equal(navigated, false);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /NAVIGATION_TARGET_UNSUPPORTED/);
  assert.match(output.result.error ?? "", /ground in that column is at y=64/);
  assert.match(output.result.error ?? "", /Choose an observed supported height/);
  assert.match(output.result.error ?? "", /build: true/);
});

test("a nearby unsupported explicit height is refused without substituting the ground in its receipt", async () => {
  const { bot } = botFixture(62);
  bot.entity.position.set(29.5, 62, -46.5);
  let navigated = false;
  const output = await new ActionRunner().run(
    createNavigateAction(
      bot,
      fakeNavigation,
      dependencies(async () => {
        navigated = true;
        return { status: "completed", elapsedMs: 5 };
      }),
    ),
    { x: 29, y: 63, z: -47, range: 0, dig: true, scaffold: true },
  );
  assert.equal(navigated, false);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /NAVIGATION_TARGET_UNSUPPORTED/);
  assert.match(output.result.error ?? "", /ground in that column is at y=62/);
  if (!("navigation" in output.result)) throw new Error("expected navigation evidence");
  assert.deepEqual(output.result.navigation.target, { x: 29, y: 63, z: -47 });
  assert.equal(output.result.navigation.remainingDistance, 1);
  assert.match(formatNavigateResult(output.result), /Target: `29, 63, -47`/);
});

test("build: true accepts a mid-air target on purpose and routes to it", async () => {
  const { bot } = botFixture();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    navigated = true;
    bot.entity.position.set(120.5, 99, -35.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 99, z: -36, range: 2, build: true },
  );

  assert.equal(navigated, true);
  assert.equal(output.result.status, "succeeded");
});

test("a supported target inside solid terrain is left to excavation policy", async () => {
  const { bot } = botFixture();
  let navigated = false;
  const run: NavigateDependencies["navigate"] = async () => {
    navigated = true;
    bot.entity.position.set(0.5, 60, 0.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 0, y: 60, z: 0, range: 0 },
  );
  assert.equal(navigated, true);
  assert.equal(output.result.status, "succeeded");
});

test("a target on a ledge within range is a place the bot can be", async () => {
  const { bot } = botFixture();
  const ledge = new Vec3(120, 96, -36);
  const world = bot.blockAt;
  bot.blockAt = ((cell: Vec3) =>
    cell.equals(ledge)
      ? { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      : world(cell)) as Bot["blockAt"];
  const run: NavigateDependencies["navigate"] = async (): Promise<NavigationResult> => {
    bot.entity.position.set(120.5, 97, -35.5);
    return { status: "completed", elapsedMs: 5 };
  };
  const output = await new ActionRunner().run(
    createNavigateAction(bot, fakeNavigation, dependencies(run)),
    { x: 120, y: 98, z: -36, range: 2 },
  );

  assert.equal(output.result.status, "succeeded");
});
