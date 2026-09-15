import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { z } from "zod";
import { defineAction, actionResultSchema } from "../../actions/action.js";
import { readNotificationSummary, SqlBotData } from "../../bot-data/index.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import type { CombatController, CombatOutcome } from "../control/combat/contract.js";
import { ReflexDriver } from "../control/driver.js";
import { attachSurvivalReceipts } from "../evidence/receipts.js";
import { SurvivalObserver } from "../evidence/status.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";

import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { observeHostileResponse } from "../control/combat/observation.js";
import { executeHostileResponse } from "../control/combat/respond.js";
import { completeResponse, encounterReceipt } from "../control/combat/settlement.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { attachHostileReflex } from "./hostile.js";

type Entity = Parameters<Bot["attack"]>[0];

for (const escapes of [true, false]) {
  test(`withdrawal ${escapes ? "resumes its request after safe separation" : "returns when escape has no path"}`, async () => {
    const fixture = reflexFixture(
      async () => {
        throw new Error("Withdrawal must not engage");
      },
      async () => {
        if (!escapes) return { status: "stopped", reason: "no path", elapsedMs: 1 };
        fixture.bot.entity.position.x = 60;
        return { status: "completed", elapsedMs: 1 };
      },
    );
    fixture.bot.entities[7] = hostile(7, "blaze", 5);
    let attempts = 0;
    const input = z.object({ destination: z.number() });
    const action = defineAction({
      name: "withdraw_test",
      description: "withdraw",
      inputSchema: input,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (value: unknown) => input.parse(value),
      execution: { kind: "resumable_task" },
      begin: (request) => async (context) => {
        attempts++;
        if (attempts === 1) {
          const stopped = new Promise<void>((resolve) =>
            context.signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          fixture.tick();
          await stopped;
          return { status: "failed", error: "interrupted" };
        }
        assert.equal(request.destination, 70);
        return { status: "succeeded" };
      },
    });
    try {
      await fixture.controller.policy.edit({
        operation: "set",
        expected_revision: fixture.controller.policy.snapshot().revision,
        changes: { combat: { engagement: "defend_only" } },
        lifetime: { kind: "session" },
        reason: "test",
      });
      const output = await fixture.runner.run(action, { destination: 70 });
      assert.equal(output.result.status, escapes ? "succeeded" : "failed");
      assert.equal(attempts, escapes ? 2 : 1);
      assert.ok(await until(() => fixture.recorded().length > 0));
      assert.deepEqual(fixture.recorded(), [escapes ? "evade -> safe_separation" : "evade -> capability_limit"]);
    } finally {
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

function hostile(id: number, name: string, x: number): Entity {
  return {
    id,
    name,
    displayName: name,
    kind: "Hostile mobs",
    isValid: true,
    height: 2,
    width: 0.6,
    metadata: [],
    position: new Vec3(x, 64, 0),
  } as unknown as Entity;
}

test("an automatic target disappearing resumes the original request without claiming a kill", async () => {
  const fixture = reflexFixture(async (targetId) => {
    fixture.bot.entities[targetId]!.isValid = false;
    return { ...died(targetId), kind: "target_lost", attacks: 0 };
  });
  fixture.bot.entities[7] = hostile(7, "blaze", 5);
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "interrupted_collection",
    description: "preserve the requested collection",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      if (++attempts === 1) {
        const stopped = new Promise<void>((resolve) =>
          context.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        fixture.tick();
        await stopped;
        return { status: "failed", error: "interrupted" };
      }
      assert.equal(request.count, 12);
      return { status: "succeeded" };
    },
  });
  try {
    const result = await fixture.runner.run(action, { count: 12 });
    assert.equal(result.result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["fight -> target_lost"]);
    assert.equal(fixture.observer.threats.resolvedIds.has(7), false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

function reflexFixture(
  engage: CombatController["engage"],
  navigate: NavigationRuntime["navigate"] = async () => ({ status: "completed", elapsedMs: 0 }),
) {
  const bot = Object.assign(new EventEmitter(), {
    username: "ReflexBot",
    _client: new EventEmitter(),
    health: 20,
    game: { gameMode: "survival", dimension: "overworld" },
    food: 20,
    // Open air with nothing carried: a hide here can dig nothing and place
    // nothing, which is the state the standing-down rule exists for.
    inventory: Object.assign(new EventEmitter(), { items: () => [], slots: new Array(46).fill(null) }),
    registry: minecraftData("1.21.4"),
    blockAt: () => null,
    world: { raycast: () => null },
    entity: { id: 1, onGround: true, position: new Vec3(0, 64, 0), width: 0.6, height: 1.8 },
    entities: {} as Record<number, Entity>,
    isSleeping: false,
    clearControlStates: () => undefined,
    deactivateItem: () => undefined,
    equip: async () => undefined,
    unequip: async () => undefined,
    attack: () => undefined,
  }) as unknown as Bot;
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "reflex-test", scope: { kind: "bot", botId: "reflex-bot" } },
  });
  const runner = new ActionRunner();
  const navigation = {
    onEvent: () => () => {},
    active: false,
    cancel: () => undefined,
    navigate,
  } as unknown as NavigationRuntime;
  const controller: CombatController = {
    resourceRefusal: () => null,
    policy: new SurvivalPolicyState(bot),
    engage,
    stop: async () => undefined,
    runEnd: async () => {
      throw new Error("Unexpected End combat");
    },
    endDanger: () => false,
    activePosition: () => null,
    execution: () => null,
    onDecision: () => () => {},
    finish: async () => ({
      observedAt: 1,
      kind: "safe" as const,
      basis: "clear" as const,
      position: { x: 0, y: 64, z: 0 },
    }),
    canRecover: () => false,
    activeEngagement: () => null,
  };
  const driver = new ReflexDriver(bot, runner);
  const perception = new CombatPerception(bot);
  const attached = attachHostileReflex(bot, driver, navigation, controller, perception);
  const status = new SurvivalObserver(bot, runner, driver, controller);
  const receipts = attachSurvivalReceipts(bot, data, runner, driver, controller, status, navigation);
  const observer = {
    ...attached,
    async close() {
      await attached[Symbol.asyncDispose]();
      await driver[Symbol.asyncDispose]();
      receipts[Symbol.dispose]();
      status[Symbol.dispose]();
      perception[Symbol.dispose]();
    },
  };
  return {
    bot,
    runner,
    navigation,
    controller,
    observer,
    perception,
    data,
    summary: () => readNotificationSummary(data, bot.username),
    /** The recorded encounters, oldest first, as `response -> outcome`. */
    recorded: () =>
      data
        .read(
          "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
        )
        .map((row) => {
          const payload = JSON.parse(String(row.payload_json)) as { response: string; outcome: string };
          return `${payload.response} -> ${payload.outcome}`;
        }),
    tick: () => bot.emit("physicsTick"),
  };
}

function died(targetId: number): CombatOutcome {
  return {
    kind: "died",
    targetId,
    attacks: 1,
    stylesUsed: ["melee"],
    weaponsUsed: ["hand"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  };
}

test("a food-policy revocation cancels a protected automatic recovery bite", async () => {
  const fixture = reflexFixture(async () => { throw new Error("A hide must not engage"); });
  fixture.bot.blockAt = (() => ({
    name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], hardness: 1.5, position: new Vec3(0, 0, 0),
  })) as unknown as Bot["blockAt"];
  fixture.bot.health = 2;
  fixture.bot.food = 10;
  fixture.bot.entities[7] = hostile(7, "zombie", 12);
  fixture.bot.inventory.items = () => [{ name: "beef", count: 2 } as Item];
  let rejectBite!: (cause: Error) => void;
  fixture.bot.consume = () => new Promise<void>((_resolve, reject) => {
    fixture.bot.usingHeldItem = true;
    rejectBite = reject;
  });
  fixture.bot.deactivateItem = () => {
    fixture.bot.usingHeldItem = false;
    rejectBite?.(new Error("bite released"));
  };
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.bot.usingHeldItem));
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "keep raw meat" });
    assert.equal(fixture.bot.usingHeldItem, false);
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.controller.policy.settling, false);
    assert.equal(fixture.bot.inventory.items()[0]?.count, 2);
  } finally {
    rejectBite?.(new Error("test cleanup"));
    await fixture.observer.close();
    fixture.data.close();
  }
});

for (const kind of ["mob", "end"] as const) {
  test(`hostile takeover ${kind === "end" ? "awaits End cleanup" : "leaves an ordinary fight in charge"}`, async () => {
    let active: { kind: "mob" | "end"; targetId: number } | null = { kind, targetId: 42 };
    let defenses = 0,
      cleaning = false,
      started = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const fixture = reflexFixture(async (id) => {
      assert.equal(active, null, "the old combat owner must release before a new fight starts");
      defenses++;
      return died(id);
    });
    fixture.controller.activeEngagement = () => active;
    fixture.bot.entities[7] = hostile(7, "zombie", 2);
    const request = z.strictObject({});
    const action = defineAction({
      name: "occupied_combat_test",
      description: "Exercise physical handoff",
      inputSchema: request,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (input) => request.parse(input),
      execution: { kind: "task" },
      execute: async (_, { signal }) => {
        started = true;
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        cleaning = true;
        await cleanup;
        active = null;
        signal!.throwIfAborted();
        return { status: "succeeded" };
      },
    });
    const pending = fixture.runner.run(action, {});
    try {
      assert.ok(await until(() => started));
      fixture.tick();
      if (kind === "end") {
        assert.ok(await until(() => cleaning));
        assert.equal(fixture.runner.status().owner, "yielding");
        assert.equal(defenses, 0);
        fixture.tick();
      } else {
        assert.equal(fixture.runner.status().owner, "foreground");
        assert.equal(cleaning, false);
        fixture.runner.cancelActive("Test completed ordinary fight observation");
      }
      releaseCleanup();
      const output = await pending;
      assert.equal(output.result.status, "cancelled");
      if (kind === "end") assert.ok(await until(() => fixture.recorded().length === 1));
      assert.equal(defenses, kind === "end" ? 1 : 0);
      assert.equal(fixture.runner.status().owner, "idle");
    } finally {
      releaseCleanup();
      fixture.runner.cancelActive("Test cleanup");
      await pending;
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

test("an incoming blaze projectile starts combat before damage beyond observation range", async () => {
  const fixture = reflexFixture(async (id) => died(id));
  try {
    fixture.bot.entities[7] = hostile(7, "blaze", 26);
    fixture.bot.entities[8] = Object.assign(hostile(8, "small_fireball", 20), {
      kind: "Projectiles",
      position: new Vec3(20, 65, 0),
      velocity: new Vec3(0, 0, 0),
      width: 0.3125,
    });
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: -4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().owner, "takeover");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
    assert.equal(fixture.bot.health, 20);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a blaze shot travelling away does not attribute another victim's combat to us", async () => {
  const fixture = reflexFixture(async (id) => died(id));
  try {
    fixture.bot.entities[7] = hostile(7, "blaze", 26);
    fixture.bot.entities[8] = Object.assign(hostile(8, "small_fireball", 20), {
      kind: "Projectiles",
      position: new Vec3(20, 65, 0),
      velocity: new Vec3(0.5, 0, 0),
      width: 0.3125,
    });
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: 4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.observer.threats.attackerIds.size, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/** Let the claimed response run to its recorded event, or give up after a bounded number of turns. */
async function until(condition: () => boolean, turns = 50): Promise<boolean> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

test("the automatic enderman response holds its stance across a teleport", async () => {
  const fixture = reflexFixture(async (targetId, signal, movement) => {
    assert.equal(movement, "hold");
    fixture.bot.entities[targetId]!.position.x = 8;
    fixture.bot.emit("physicsTick");
    assert.equal(signal.aborted, false, "a teleport beyond melee reach does not cancel the guard");
    return died(targetId);
  });
  const enderman = hostile(7, "enderman", 3);
  Reflect.set(enderman.metadata, fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"), true);
  fixture.bot.entities[7] = enderman;
  try {
    fixture.bot.emit("entityHurt", fixture.bot.entity, enderman);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("claims an idle body for a hostile in contact and records what happened", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId));
  fixture.bot.entities[7] = hostile(7, "zombie", 3);

  fixture.tick();
  assert.equal(fixture.runner.status().owner, "takeover");
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  assert.equal(fixture.runner.status().busy, false);
  assert.ok(await until(() => fixture.bot.listenerCount("death") === 2));
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a denied reflex claim removes its death listener", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId));
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  Object.defineProperty(fixture.runner, "claim", {
    value: () => ({ kind: "busy", activeAction: { action: "other", startedAt: new Date().toISOString() } }),
  });
  fixture.tick();
  assert.equal(fixture.bot.listenerCount("death"), 2);
  assert.deepEqual(fixture.recorded(), []);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an emergency retreat excludes momentum-dependent parkour while preserving supported movement", async () => {
  let called = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ movements }) => {
      called = true;
      assert.equal(movements.allowParkour, false);
      assert.equal(movements.allowSprinting, true);
      assert.equal(movements.allowPlacing, true);
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          fixture.bot,
          fixture.navigation,
          fixture.controller,
          directive,
          fixture.observer.threats,
          11,
          new AbortController().signal,
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(called, true);
    assert.equal(result.outcome, "safe_separation");
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("an admitted low-health escape is not stopped for a stationary guard it cannot sustain", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ stopSignal }) => {
      assert.equal(stopSignal?.aborted, false);
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "blaze", 3);
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  fixture.bot.health = 7;
  fixture.bot.inventory.slots[45] = { name: "shield" } as NonNullable<Bot["inventory"]["slots"][number]>;
  fixture.bot.entities[8] = Object.assign(hostile(8, "small_fireball", 8), {
    position: new Vec3(8, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  try {
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          fixture.bot,
          fixture.navigation,
          fixture.controller,
          directive,
          fixture.observer.threats,
          11,
          new AbortController().signal,
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(result.outcome, "safe_separation");
    assert.equal(result.projectileGuards, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("direct encounter cancellation cannot report safe separation after route cleanup", async () => {
  const cancellation = new AbortController();
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      cancellation.abort("operator cancellation");
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  const result = encounterReceipt(
    completeResponse(
      await executeHostileResponse(
        fixture.bot,
        fixture.navigation,
        fixture.controller,
        directive,
        fixture.observer.threats,
        11,
        cancellation.signal,
      ),
      cancellation.signal,
    ),
  );
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.error, "operator cancellation");
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

for (const floor of ["safe", "damaging", "airborne"] as const) {
  test(`an evade timeout beyond required separation checks ${floor} footing before its verdict`, async () => {
    const fixture = reflexFixture(
      async (id) => died(id),
      async () => {
        fixture.bot.entity.position.x = -40;
        fixture.bot.entity.onGround = floor !== "airborne";
        return { status: "stopped", reason: "navigation timeout", elapsedMs: 15_000 };
      },
    );
    const world = new MemoryWorld();
    world.load({ x: -40, y: 63, z: 0 }, { stateId: 1, traits: { damaging: floor === "damaging" } });
    world.load({ x: -40, y: 64, z: 0 }, { stateId: 0 });
    world.load({ x: -40, y: 65, z: 0 }, { stateId: 0 });
    Object.defineProperty(fixture.navigation, "world", { value: world });
    fixture.bot.health = 11;
    fixture.bot.entities[7] = hostile(7, "zombie", 3);
    const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
    assert.equal(directive.kind, "evade");
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          fixture.bot,
          fixture.navigation,
          fixture.controller,
          directive,
          fixture.observer.threats,
          11,
          new AbortController().signal,
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(result.outcome, floor === "safe" ? "safe_separation" : "capability_limit");
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("a controller cancellation after a policy edit preserves the cancellation receipt", async () => {
  const fixture = reflexFixture(async (targetId) => {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: "never" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    return { ...died(targetId), kind: "cancelled" };
  });
  try {
    fixture.bot.entities[7] = hostile(7, "blaze", 3);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("unchanged failed fight stays suppressed when no alternate response is permitted", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("equipment unavailable");
  });
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  fixture.bot.entities[7] = hostile(7, "zombie", 3);

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  fixture.tick();

  assert.equal(fixture.runner.status().busy, false);
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("the reflex awaits combat recovery and records its capability limit", async () => {
  let engaging = false;
  let recoveryBlocked = () => {};
  const fixture = reflexFixture(
    (targetId) =>
      new Promise((resolve) => {
        engaging = true;
        recoveryBlocked = () =>
          resolve({
            ...died(targetId),
            kind: "capability_blocked",
            reason: "recovery",
            observation: "No food remains.",
            attacks: 2,
          });
      }),
  );
  fixture.bot.entities[7] = hostile(7, "skeleton", 5);
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  assert.equal(fixture.runner.status().busy, true, "health alone does not settle the encounter");
  recoveryBlocked();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("melee contact ending releases the reflex without marking the target unreachable", async () => {
  let engaging = false;
  const fixture = reflexFixture(
    (targetId, signal, movement) =>
      new Promise((resolve) => {
        assert.equal(movement, "hold");
        engaging = true;
        signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
      }),
  );
  fixture.bot.entities[7] = hostile(7, "magma_cube", 3);
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.bot.entities[7]!.position.y = 58;
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  assert.equal(fixture.observer.threats.unreachableIds.has(7), false);
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("ending the original melee contact cannot drop the owner while another fuse needs clearance", async () => {
  let engaging = false;
  const fixture = reflexFixture((targetId, signal) => new Promise(resolve => {
    engaging = true;
    signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
  }));
  fixture.bot.entities[7] = hostile(7, "magma_cube", 3);
  fixture.tick();
  assert.ok(await until(() => engaging));
  const creeper = hostile(8, "creeper", 2);
  fixture.bot.entities[8] = creeper;
  const swell = fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  Reflect.set(creeper.metadata, swell, 1);
  fixture.perception.creeperClearance.require(fixture.perception.creeperClearance.observe(fixture.perception.tick, new Set()));
  fixture.bot.entities[7]!.position.y = 58;
  fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false);
  delete fixture.bot.entities[8];
  fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false, "missing is not discharged");
  fixture.perception.creeperClearance.resolve(8);
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  await fixture.observer.close();
  fixture.data.close();
});

test("damage below the hide threshold does not stop an already admitted escape", async () => {
  let escaping = false;
  let finish: () => void = () => assert.fail("escape has not started");
  const navigate: NavigationRuntime["navigate"] = async ({ signal, stopSignal, timeoutMs }) => {
    assert.equal(stopSignal?.aborted, false, "only an incoming projectile can pause this route");
    assert.ok(
      typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= 15_000,
      "the route shares the existing emergency limit with guards",
    );
    escaping = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assert.equal(signal?.aborted, false);
    assert.equal(stopSignal?.aborted, false, "health loss must not interrupt the admitted route");
    return { status: "completed", elapsedMs: 1000 };
  };
  const fixture = reflexFixture(async (targetId) => died(targetId), navigate);
  fixture.bot.health = 9;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  fixture.tick();
  assert.equal(fixture.runner.status().busy, true);
  assert.deepEqual(fixture.recorded(), []);
  fixture.bot.entity.position.x = -40;
  finish();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});
test("one evade retains its first threat and records a new contact encountered along its route", async () => {
  let attempts = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ goal }) => {
      const snapshot = () =>
        ({ entities: new Map(Object.values(fixture.bot.entities).map((entity) => [entity.id, entity])) }) as never;
      const initial = goal.resolve(snapshot());
      assert.equal(initial.kind, "active");
      if (initial.kind === "active" && attempts++ === 0) assert.doesNotMatch(initial.revision, /entity:8:/);
      fixture.bot.entity.position = new Vec3(-12, 64, 0);
      fixture.tick();
      const revised = goal.resolve(snapshot());
      assert.equal(revised.kind, "active");
      if (revised.kind === "active") {
        assert.match(revised.revision, /entity:7:/);
        assert.match(revised.revision, /entity:8:/);
      }
      // Away from the first threat alone is not enough to report safe separation.
      fixture.bot.entity.position = new Vec3(-40, 64, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  );
  // Admit guarded retreat; these assertions concern its contact bookkeeping.
  fixture.bot.inventory.slots[45] = { name: "shield", count: 1 } as Item;
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "blaze", 4);
  fixture.bot.entities[8] = hostile(8, "blaze", -26);
  const listeners = fixture.bot.listenerCount("physicsTick");
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  const payload = JSON.parse(
    String(
      fixture.data.read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )[0]?.payload_json,
    ),
  );
  assert.deepEqual(
    payload.finalDistances.map((entry: { id: number }) => entry.id),
    [7, 8],
  );
  assert.equal(fixture.bot.listenerCount("physicsTick"), listeners);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a hostile that has hurt the bot is in contact from beyond the contact range", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId));
  const skeleton = hostile(7, "skeleton", 12);
  fixture.bot.entities[7] = skeleton;

  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  fixture.bot.emit("entityHurt", fixture.bot.entity, skeleton);
  fixture.tick();

  assert.equal(fixture.runner.status().owner, "takeover");
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

/**
 * The livelock of 2026-09-04, at the observer: a hide that could do nothing was
 * chosen again every second, and each choice claimed the body and cancelled
 * whatever the model had started. Eighty-four notifications in half a minute,
 * and a bot that did not move a block in a hundred and sixty ticks.
 */
test("a hide that could not be built is recorded once and then the reflex stands down", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId));
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false, melee: false, shield: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  fixture.bot.health = 7;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["hide -> capability_limit"]);
  // The memory is what stops the next decision, and it is keyed on the state
  // the hide failed in rather than on a cooldown that expires.
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false, "the body stays with the model");
  assert.ok(fixture.observer.threats.blockedResponses?.has("hide"));
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a changed shelter permission retries a failed hide while an unrelated bow edit does not", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId));
  const edit = (bow: boolean, place: boolean) =>
    fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { retreat: false, melee: false, shield: false, bow, terrain: { dig: false, place } } },
      lifetime: { kind: "session" },
      reason: "test",
    });
  try {
    await edit(false, false);
    fixture.bot.health = 7;
    fixture.bot.entities[7] = hostile(7, "zombie", 3);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1 && !fixture.runner.status().busy));

    await edit(true, false);
    fixture.tick();
    assert.equal(await until(() => fixture.recorded().length > 1, 5), false);

    await edit(true, true);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 2));
    assert.deepEqual(fixture.recorded(), ["hide -> capability_limit", "hide -> capability_limit"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("records a session teardown during a response as cancelled, not failed", async () => {
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  fixture.bot.entities[7] = hostile(7, "zombie", 3);

  fixture.tick();
  fixture.runner.cancelActive("Minecraft runtime closed");

  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an admitted low-health escape still yields to session cancellation", async () => {
  let escaping = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ signal }) =>
      new Promise((resolve) => {
        escaping = true;
        signal!.addEventListener(
          "abort",
          () => resolve({ status: "stopped", reason: "session cancelled", elapsedMs: 0 }),
          { once: true },
        );
      }),
  );
  fixture.bot.health = 9;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  fixture.runner.cancelActive("Minecraft runtime closed");
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("cancellation does not conceal a different failure while combat releases the body", async () => {
  let engaged = false;
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        engaged = true;
        signal.addEventListener("abort", () => reject(new Error("shield release failed")), { once: true });
      }),
  );
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  try {
    fixture.tick();
    assert.ok(await until(() => engaged));
    fixture.runner.cancelActive("operator cancellation");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> failed"]);
    const row = fixture.data.read(
      "SELECT payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id DESC LIMIT 1",
    )[0]!;
    assert.match(String(row.payload_json), /shield release failed/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cancelled escape preserves its attack and kill evidence when navigation throws", async () => {
  let attacks = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.tick();
      fixture.bot.emit("entityDead", fixture.bot.entities[7]!);
      fixture.runner.cancelActive("footing recovery");
      throw new Error("navigation released during cancellation");
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "zombie", 2);
  fixture.bot.attack = () => {
    attacks++;
  };
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.equal(attacks, 1);
    const row = fixture.data.read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    )[0]!;
    const evidence = JSON.parse(String(row.payload_json));
    assert.equal(evidence.outcome, "cancelled");
    assert.equal(evidence.attacks, 1);
    assert.deepEqual(evidence.weaponsUsed, ["hand"]);
    assert.deepEqual(evidence.killedTargetIds, [7]);
    assert.match(evidence.error, /footing recovery/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const cleanup of ["returns", "throws"] as const) {
  test(`encounter death evidence survives respawn before cleanup ${cleanup}`, async () => {
    let started = false;
    let finish: () => void = () => assert.fail("combat has not started");
    const fixture = reflexFixture(
      (targetId, signal) =>
        new Promise((resolve, reject) => {
          started = true;
          finish = () =>
            cleanup === "throws"
              ? reject(signal.reason ?? new Error("cleanup failed after death"))
              : resolve({ ...died(targetId), kind: "bot_died", attacks: 3 });
        }),
    );
    fixture.bot.entities[7] = hostile(7, "zombie", 15);
    fixture.bot.entity.position = new Vec3(12, 70, 9);
    fixture.bot.entities[7].position = new Vec3(15, 70, 9);
    // Real player-events cancellation happens on death, before cleanup settles.
    const cancelOnDeath = () => {
      fixture.runner.cancelActive("bot died");
    };
    fixture.bot.on("death", cancelOnDeath);
    fixture.tick();
    assert.ok(await until(() => started));
    fixture.bot.health = 0;
    fixture.bot.emit("death");
    fixture.bot.health = 20;
    fixture.bot.entity.position = new Vec3(79.5, 66, 134.5);
    fixture.bot.entities[7].position = new Vec3(200, 70, 9);
    fixture.bot.emit("respawn");
    finish();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> bot_died"]);
    const payload = JSON.parse(
      String(
        fixture.data.read(
          "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex'",
        )[0]!.payload_json,
      ),
    );
    assert.equal(payload.healthBefore, 20);
    assert.equal(payload.healthAfter, 0);
    assert.deepEqual(payload.finalPosition, { x: 12, y: 70, z: 9 });
    assert.deepEqual(payload.finalDistances, [{ id: 7, distance: 3 }]);
    assert.equal(payload.attacks, cleanup === "returns" ? 3 : 0);
    fixture.bot.off("death", cancelOnDeath);
    assert.equal(fixture.bot.listenerCount("death"), 2);
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("safe separation answers old distant attack contact, while later damage re-arms it", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      routes += 1;
      fixture.bot.entity.position.x = -20;
      return { status: "completed", elapsedMs: 0 };
    },
  );
  // Admit guarded retreat; these assertions concern its contact bookkeeping.
  fixture.bot.inventory.slots[45] = { name: "shield", count: 1 } as Item;
  fixture.bot.health = 11;
  const shooter = hostile(7, "blaze", 28);
  fixture.bot.entities[7] = shooter;
  fixture.bot.emit("entityHurt", fixture.bot.entity, shooter);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  for (let tick = 0; tick < 5; tick++) {
    fixture.tick();
    await until(() => !fixture.runner.status().busy);
  }
  assert.equal(routes, 1, "already answered contact must not repeatedly claim the same satisfied escape");
  fixture.bot.emit("entityHurt", fixture.bot.entity, shooter);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.equal(routes, 2);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("safe separation cannot erase a new attack observed during the response", async () => {
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      fixture.bot.entity.position.x = -20;
      fixture.bot.emit("entityHurt", fixture.bot.entity, fixture.bot.entities[7]);
      return { status: "completed", elapsedMs: 0 };
    },
  );
  // Admit guarded retreat; these assertions concern its contact bookkeeping.
  fixture.bot.inventory.slots[45] = { name: "shield", count: 1 } as Item;
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "blaze", 28);
  fixture.bot.emit("entityHurt", fixture.bot.entity, fixture.bot.entities[7]);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.equal(fixture.observer.threats.attackerIds.has(7), true);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("failed evade immediately yields to the newly chosen hide response", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => ({ status: "stopped", reason: "timeout", elapsedMs: 15_000 }),
  );
  fixture.bot.health = 9;
  fixture.bot.entities[7] = hostile(7, "zombie", 3);
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy && fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("evade refreshes a completed route when a newly observed cube is still in contact", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      routes++;
      if (routes === 1) {
        fixture.bot.entity.position.x = 40;
        fixture.bot.entities[8] = hostile(8, "magma_cube", 35);
        fixture.bot.emit("entitySpawn", fixture.bot.entities[8]);
      } else fixture.bot.entity.position.x = 80;
      return { status: "completed", elapsedMs: 1 };
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "magma_cube", 3);
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          fixture.bot,
          fixture.navigation,
          fixture.controller,
          directive,
          fixture.observer.threats,
          11,
          new AbortController().signal,
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(routes, 2);
    assert.equal(result.outcome, "safe_separation");
    assert.ok(result.finalDistances.every((entry) => entry.distance >= 36));
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cube killed during retreat does not fail separation against its last position", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.bot.emit("entityDead", fixture.bot.entities[7]!);
      delete fixture.bot.entities[7];
      return { status: "completed", elapsedMs: 1 };
    },
  );
  fixture.bot.health = 11;
  fixture.bot.entities[7] = hostile(7, "magma_cube", 3);
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          fixture.bot,
          fixture.navigation,
          fixture.controller,
          directive,
          fixture.observer.threats,
          11,
          new AbortController().signal,
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(result.outcome, "safe_separation");
    assert.deepEqual(result.finalDistances, []);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/**
 * The 2026-09-09 livelock, at the observer: a withdrawal interrupted by a hide
 * that left the bot under the hide bar was resumed, dug out of its own box into
 * the same sight line, and was hidden again - seven times, with the model
 * never told. The hide must hand the body back to the model instead.
 */
test("a hide that leaves the bot under the hide bar does not resume a withdrawal", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  });
  // Already sealed in, so the hide goes straight to the hold; two health with
  // hunger below the regeneration bar and nothing to eat, so the hold has
  // nothing to wait for and ends at once.
  fixture.bot.blockAt = (() => ({
    name: "stone",
    boundingBox: "block",
    shapes: [[0, 0, 0, 1, 1, 1]],
    hardness: 1.5,
    position: new Vec3(0, 0, 0),
  })) as unknown as Bot["blockAt"];
  fixture.bot.health = 2;
  fixture.bot.food = 10;
  // In sight and inside observation range, outside the contact range: under the
  // hide bar that is contact, and the answer is a hide.
  fixture.bot.entities[7] = hostile(7, "zombie", 12);
  let attempts = 0;
  const input = z.object({});
  const action = defineAction({
    name: "withdraw_test",
    description: "withdraw",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: () => async (context) => {
      attempts++;
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const output = await fixture.runner.run(action, {});
    assert.equal(output.result.status, "failed");
    assert.equal(attempts, 1);
    assert.ok(await until(() => fixture.recorded().length > 0));
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
    const [payload] = fixture.data
      .read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )
      .map((row) => JSON.parse(String(row.payload_json)) as { error: string; hide: { enclosed: boolean } });
    assert.equal(payload?.hide.enclosed, true);
    assert.match(payload?.error ?? "", /health is still 2: nothing carried can restore it/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a recovered hide resumes the same admitted request", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  });
  fixture.bot.blockAt = (() => ({
    name: "stone",
    boundingBox: "block",
    shapes: [[0, 0, 0, 1, 1, 1]],
    hardness: 1.5,
    position: new Vec3(0, 0, 0),
  })) as unknown as Bot["blockAt"];
  fixture.bot.health = 2;
  fixture.bot.entities[7] = hostile(7, "zombie", 12);
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "recover_request_test",
    description: "Resume a request after native health recovery",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      assert.equal(request.count, 12);
      if (++attempts === 2) return { status: "succeeded" };
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const pending = fixture.runner.run(action, { count: 12 });
    assert.ok(await until(() => fixture.observer.activeResponse() === "hide"));
    fixture.bot.health = 18;
    fixture.tick();
    assert.equal((await pending).result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const inUse of [false, true]) {
  test(`nearby hostile shield preparation respects active item use (${inUse})`, async () => {
    const fixture = reflexFixture(async () => assert.fail("Preparation must not engage"));
    const shield = { name: "shield", type: fixture.bot.registry.itemsByName.shield!.id, count: 1, slot: 10 } as Item;
    fixture.bot.inventory.items = () => [shield];
    fixture.bot.usingHeldItem = inUse;
    fixture.bot.entities[7] = hostile(7, "zombie", 12);
    let equips = 0;
    fixture.bot.equip = async (_item, destination) => {
      assert.equal(destination, "off-hand");
      equips++;
      fixture.bot.inventory.slots[45] = shield;
    };
    try {
      fixture.tick();
      if (!inUse) assert.ok(await until(() => equips === 1));
      else await new Promise((resolve) => setTimeout(resolve, 10));
      fixture.tick();
      assert.equal(equips, inUse ? 0 : 1);
      assert.equal(fixture.bot.usingHeldItem, inUse);
    } finally {
      await fixture.observer.close();
      fixture.data.close();
    }
  });
}
