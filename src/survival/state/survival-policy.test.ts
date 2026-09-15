import minecraftData from "minecraft-data";
import assert from "node:assert/strict";
import test from "node:test";
import { createSetSurvivalPolicyAction } from "../../actions/set-survival-policy/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { botFixture } from "../../test-support/bot.js";
import { recoveryAvailable } from "../perception/combat/recovery.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { permitsHide, responsePolicyChanged } from "../policy/combat/permissions.js";
import {
  DEFAULT_FOOD_POLICY,
  DEFAULT_SURVIVAL_POLICY,
  policyEditSchema,
  SURVIVAL_POLICY_PATHS,
  type PolicyChanges,
  type PolicyLifetime,
} from "../policy/contract.js";
import { recoverUnderCover } from "../responses/recover.js";
import { survivalResources } from "./resources.js";
import { SurvivalPolicyState } from "./survival-policy.js";
import { createMovements } from "../../navigation/runtime.js";

function fixture(now: () => number = Date.now) {
  const items: { name: string; count: number }[] = [];
  const bot = botFixture(
    { items },
    {
      health: 9,
      food: 15,
      game: { gameMode: "survival" },
      registry: minecraftData("1.21.4"),
    },
  );
  const policy = new SurvivalPolicyState(bot, now);
  const set = (changes: PolicyChanges, lifetime: PolicyLifetime = { kind: "session" }, reason = "test") =>
    policy.edit({
      operation: "set",
      expected_revision: policy.snapshot().revision,
      changes,
      lifetime,
      reason,
    });
  return { bot, items, policy, set };
}

test("arrow hunting preserves policy edits and releases on cancellation without enabling prohibited bows", async () => {
  const { policy, set } = fixture();
  const hunt = new AbortController();
  policy.reserveArrows(hunt.signal);
  assert.equal(policy.combat.bow, false);
  await set({ combat: { hide: "never", bow: true } });
  assert.equal(policy.snapshot().effective.combat.bow, false);
  assert.equal(policy.combat.hide, "never");
  hunt.abort("cancelled");
  assert.equal(policy.combat.bow, true);
  assert.equal(policy.combat.hide, "never");

  await set({ combat: { bow: false } });
  const second = new AbortController();
  policy.reserveArrows(second.signal);
  second.abort("failed");
  assert.equal(policy.combat.bow, false);
  await policy.reset("death");
  policy.reserveArrows(second.signal);
  assert.equal(policy.combat.bow, true, "an ended request cannot reserve arrows");
});

test("the public policy edit exposes every group and reconciles the consumers of what changed", async () => {
  const { policy } = fixture();
  const before = policy.combat;
  const edit = policyEditSchema.parse({
    operation: "set",
    expected_revision: policy.snapshot().revision,
    lifetime: { kind: "session" },
    reason: "exercise every group",
    changes: {
      navigation: { hostile_avoidance_multiplier: 2 },
      combat: {
        engage_min_health: 9,
        critical_health: 5,
        recover_to_health: 15,
        protected_wait_ticks: 80,
        enderman_wait_ticks: 120,
        volley_wait_ticks: 60,
        recovery_timeout_ms: 30_000,
        evade_timeout_ms: 12_000,
        evade_safe_range: 24,
      },
      food: { raw: { hunger_at_most: 9 } },
    },
  });
  await policy.edit(edit);
  assert.equal(policy.snapshot().effective.navigation.hostile_avoidance_multiplier, 2);
  assert.ok(SURVIVAL_POLICY_PATHS.has("navigation.hostile_avoidance_multiplier"));
  assert.equal(policy.snapshot().effective.combat.recover_to_health, 15);
  assert.deepEqual(
    policy.snapshot().effective.food.raw,
    { allow: "emergency_only", hunger_at_most: 9, health_below: 10 },
    "a partial food change keeps the other floors at their defaults",
  );
  for (const response of ["fight", "hide", "evade"] as const)
    assert.equal(responsePolicyChanged(before, policy.combat, response), true);
  assert.equal(responsePolicyChanged(before, policy.combat, "deflect"), false);
  assert.equal(policyEditSchema.safeParse({ ...edit, changes: { combat: { recover_to_health: 21 } } }).success, false);
  assert.equal(policyEditSchema.safeParse({ ...edit, changes: { combat: { protected_wait_ticks: 0 } } }).success, false);
  for (const multiplier of [-1, Infinity, NaN])
    assert.equal(policyEditSchema.safeParse({
      ...edit, changes: { navigation: { hostile_avoidance_multiplier: multiplier } },
    }).success, false);
  assert.equal(policyEditSchema.safeParse({ ...edit, changes: { hide: "never" } }).success, false, "fields are grouped");
  assert.equal(policyEditSchema.safeParse({ ...edit, reason: "" }).success, false, "every edit says why");
  await policy.edit({ operation: "reset", expected_revision: policy.snapshot().revision, reason: "test completed" });
  assert.deepEqual(policy.effective, DEFAULT_SURVIVAL_POLICY);
});

test("scaffold preference is a validated array override, and clear restores the default", async () => {
  const { bot, policy, set } = fixture();
  const registry = bot.registry;
  const carried = [
    { type: registry.itemsByName.end_stone.id, name: "end_stone", count: 64 },
    { type: registry.itemsByName.cobbled_deepslate.id, name: "cobbled_deepslate", count: 1 },
  ];
  Reflect.set(bot.inventory, "items", () => carried);
  await set({ navigation: { scaffold_blocks: ["cobbled_deepslate", "end_stone"] } });
  assert.deepEqual(policy.effective.navigation.scaffold_blocks, ["cobbled_deepslate", "end_stone"]);
  assert.equal(createMovements(bot).scaffold?.itemType, registry.itemsByName.cobbled_deepslate.id);
  assert.deepEqual(policy.snapshot().overrides[0]?.value, ["cobbled_deepslate", "end_stone"]);

  await set({ navigation: { scaffold_blocks: [] } }, { kind: "for", duration_ms: 1000 });
  assert.equal(createMovements(bot).scaffold, null, "an empty policy list disables automatic scaffold");
  await policy.edit({
    operation: "clear",
    expected_revision: policy.snapshot().revision,
    paths: ["navigation.scaffold_blocks"],
    reason: "restore defaults",
  });
  assert.deepEqual(policy.effective.navigation.scaffold_blocks, DEFAULT_SURVIVAL_POLICY.navigation.scaffold_blocks);
  assert.equal(Object.isFrozen(policy.effective.navigation.scaffold_blocks), true);
  assert.equal(createMovements(bot).scaffold?.itemType, registry.itemsByName.cobbled_deepslate.id);
  assert.equal(SURVIVAL_POLICY_PATHS.has("navigation.scaffold_blocks"), true);
  const encounter = policy.beginEncounter();
  await set({ navigation: { scaffold_blocks: ["end_stone"] } }, { kind: "encounter", encounter_id: encounter });
  assert.equal(createMovements(bot).scaffold?.itemType, registry.itemsByName.end_stone.id);
  await policy.endEncounter();
  assert.deepEqual(policy.effective.navigation.scaffold_blocks, DEFAULT_SURVIVAL_POLICY.navigation.scaffold_blocks);
  assert.equal(Object.isFrozen(policy.effective.navigation.scaffold_blocks), true, "expiry restores an immutable default list");

  await assert.rejects(set({ navigation: { scaffold_blocks: ["dirt", "dirt"] } }), /POLICY_SCAFFOLD_DUPLICATE/);
  await assert.rejects(set({ navigation: { scaffold_blocks: ["made_up_block"] } }), /POLICY_SCAFFOLD_UNKNOWN/);
  assert.equal(policyEditSchema.safeParse({
    operation: "set", expected_revision: policy.snapshot().revision, lifetime: { kind: "session" }, reason: "too many",
    changes: { navigation: { scaffold_blocks: Array.from({ length: 17 }, (_, index) => `block_${index}`) } },
  }).success, false);
});

test("scaffold policy is isolated per bot, immutable outside edits, and skips unsafe preferred blocks", async () => {
  const first = fixture();
  const second = fixture();
  const registry = first.bot.registry;
  const carried = ["sand", "cactus", "end_stone"].map((name) => ({
    type: registry.itemsByName[name]!.id,
    name,
    count: 64,
  }));
  Reflect.set(first.bot.inventory, "items", () => carried);
  Reflect.set(second.bot.inventory, "items", () => carried);
  await second.set({ navigation: { scaffold_blocks: [] } });
  const requested = ["sand", "cactus", "end_stone"];
  await first.set({ navigation: { scaffold_blocks: requested } });
  requested.splice(0);
  assert.deepEqual(first.policy.effective.navigation.scaffold_blocks, ["sand", "cactus", "end_stone"]);
  assert.equal(createMovements(first.bot).scaffold?.itemType, registry.itemsByName.end_stone.id,
    "falling and damaging geometry is skipped for the next valid preference");
  assert.equal(createMovements(second.bot).scaffold, null, "the other bot retains its own empty override");
  assert.throws(
    () => Array.prototype.push.call(first.policy.effective.navigation.scaffold_blocks, "dirt"),
    TypeError,
    "effective arrays cannot be mutated outside the revision barrier",
  );
});

test("foodless low health does not authorize healing enclosure, while explicit emergency cover can", () => {
  const { bot } = fixture();
  assert.equal(permitsHide(DEFAULT_COMBAT_POLICY, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)), false);
  assert.equal(
    permitsHide({ ...DEFAULT_COMBAT_POLICY, hide: "when_exposed" }, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)),
    true,
  );
  bot.food = 18;
  assert.equal(permitsHide(DEFAULT_COMBAT_POLICY, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)), true);
  assert.equal(permitsHide({ ...DEFAULT_COMBAT_POLICY, hide: "never" }, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)), false);
  assert.equal(
    permitsHide({ ...DEFAULT_COMBAT_POLICY, recover: "never" }, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)),
    false,
  );
});

test("an observed regeneration effect permits foodless recovery only while the effect lasts", async () => {
  const { bot } = fixture();
  const regeneration = bot.registry.effectsByName.Regeneration!.id;
  Reflect.set(bot.entity.effects, regeneration, { id: regeneration, amplifier: 0, duration: 100 });
  assert.equal(permitsHide(DEFAULT_COMBAT_POLICY, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)), true);
  let waits = 0;
  const result = await recoverUnderCover(bot, {
    policy: () => DEFAULT_SURVIVAL_POLICY,
    survival: survivalResources(),
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 1000,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => {
      waits++;
      delete bot.entity.effects[regeneration];
    },
  });
  assert.equal(waits, 1);
  assert.equal(result.kind, "held");
  assert.equal(permitsHide(DEFAULT_COMBAT_POLICY, recoveryAvailable(bot, DEFAULT_FOOD_POLICY)), false);
});

/**
 * The reason overrides are per field: a raw-food setting made for the whole
 * session used to vanish the moment the model switched hiding off for one
 * encounter, because the one override slot was replaced whole.
 */
test("a standing override survives a tactical edit to another field, and clear removes one path", async () => {
  const { policy, set } = fixture();
  await set({ food: { raw: { allow: "always" } } }, { kind: "session" }, "no furnace on this trip");
  const encounter = policy.beginEncounter();
  await set({ combat: { hide: "never" } }, { kind: "encounter", encounter_id: encounter }, "creepers, no cover");
  assert.equal(policy.food.raw.allow, "always");
  assert.equal(policy.combat.hide, "never");
  assert.deepEqual(
    policy.snapshot().overrides.map((override) => [override.path, override.value, override.lifetime.kind, override.reason]),
    [
      ["combat.hide", "never", "encounter", "creepers, no cover"],
      ["food.raw.allow", "always", "session", "no furnace on this trip"],
    ],
  );
  await policy.endEncounter();
  assert.equal(policy.combat.hide, "when_recovery_possible", "the encounter override expired with the encounter");
  assert.equal(policy.food.raw.allow, "always", "the session override is untouched");
  assert.match(policy.snapshot().lastChange, /Encounter ended; combat\.hide restored/);

  await policy.edit({
    operation: "clear",
    expected_revision: policy.snapshot().revision,
    paths: ["food.raw.allow"],
    reason: "furnace built",
  });
  assert.deepEqual(policy.snapshot().overrides, []);
  assert.deepEqual(policy.effective, DEFAULT_SURVIVAL_POLICY);
  await assert.rejects(
    policy.edit({
      operation: "clear",
      expected_revision: policy.snapshot().revision,
      paths: ["combat.raw_food"],
      reason: "typo",
    }),
    /POLICY_UNKNOWN_PATH/,
  );
  assert.equal(SURVIVAL_POLICY_PATHS.has("combat.terrain.dig"), true);
  assert.equal(SURVIVAL_POLICY_PATHS.has("food.raw.health_below"), true);
});

test("setting a field again replaces only that field's lifetime, and stale edits have no effect", async () => {
  const { policy, set } = fixture();
  const stale = policy.snapshot().revision;
  await set({ combat: { bow: false } });
  await set({ combat: { hide: "never" } });
  assert.equal(policy.combat.bow, false, "overrides accumulate; nothing is reset by omission");
  assert.equal(policy.combat.hide, "never");
  await set({ combat: { bow: false } }, { kind: "for", duration_ms: 60_000 }, "shorter now");
  assert.equal(policy.snapshot().overrides.find((override) => override.path === "combat.bow")?.lifetime.kind, "for");
  assert.equal(policy.snapshot().overrides.find((override) => override.path === "combat.hide")?.lifetime.kind, "session");
  await assert.rejects(
    policy.edit({ operation: "reset", expected_revision: stale, reason: "late" }),
    /POLICY_REVISION_STALE/,
  );
  assert.equal(policy.combat.hide, "never");
  const snapshot = policy.snapshot();
  snapshot.effective.combat.terrain.place = false;
  assert.equal(policy.combat.terrain.place, true, "a snapshot is a copy");
});

test("encounter and condition overrides expire once without requiring a model reset", async () => {
  const { policy, bot, set } = fixture();
  const encounter = policy.beginEncounter();
  await set({ combat: { hide: "never" } }, { kind: "encounter", encounter_id: encounter });
  assert.equal(policy.beginEncounter(), encounter);
  await policy.refresh();
  assert.equal(policy.combat.hide, "never");
  await policy.endEncounter();
  assert.deepEqual(policy.snapshot().overrides, []);
  await assert.rejects(
    set({ combat: { hide: "never" } }, { kind: "encounter", encounter_id: encounter }),
    /POLICY_ENCOUNTER_STALE/,
  );
  await set({ combat: { bow: false } }, { kind: "until", condition: { kind: "health_at_least", value: 12 } });
  bot.health = 12;
  await policy.refresh();
  const revision = policy.snapshot().revision;
  bot.health = 9;
  await policy.refresh();
  assert.equal(policy.snapshot().revision, revision);
  assert.equal(policy.combat.bow, true);
});

test("a timed override ends on its own and the change names it", async () => {
  let clock = 1_000;
  const { policy, set } = fixture(() => clock);
  await set({ combat: { retreat: false } }, { kind: "for", duration_ms: 5_000 }, "hold the doorway");
  assert.equal(policy.snapshot().overrides[0]?.expiresAt, 6_000);
  clock = 5_999;
  await policy.refresh();
  assert.equal(policy.combat.retreat, false);
  clock = 6_000;
  await policy.refresh();
  assert.equal(policy.combat.retreat, true);
  assert.match(policy.snapshot().lastChange, /Lifetime ended for combat\.retreat/);
  assert.equal(
    policyEditSchema.safeParse({
      operation: "set",
      expected_revision: "x",
      changes: { combat: { retreat: false } },
      lifetime: { kind: "for", duration_ms: 3_600_001 },
      reason: "too long",
    }).success,
    false,
  );
});

test("carried-item expiration uses observed stock and rejects already-satisfied lifetimes", async () => {
  const { policy, items, set } = fixture();
  const lifetime = {
    kind: "until" as const,
    condition: { kind: "carried_item_at_least" as const, item: "arrow", count: 16 },
  };
  await set({ combat: { bow: false } }, lifetime);
  items.push({ name: "arrow", count: 15 });
  await policy.refresh();
  assert.equal(policy.combat.bow, false);
  items[0]!.count = 16;
  await policy.refresh();
  assert.equal(policy.combat.bow, true);
  await assert.rejects(set({ combat: { bow: false } }, lifetime), /CONDITION_SATISFIED/);
});

test("policy control remains available during a claim and waits for physical cleanup", async () => {
  const { policy } = fixture();
  const runner = new ActionRunner();
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim = runner.claim("hostile_reflex", "contact", async () => {
    await cleanup;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  policy.onChange(async () => {
    await claim.outcome;
  });
  const action = createSetSurvivalPolicyAction(policy);
  const reply = runner.run(action, {
    operation: "set",
    expected_revision: policy.snapshot().revision,
    changes: { combat: { hide: "never" } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  await Promise.resolve();
  assert.equal(policy.settling, true);
  assert.equal(runner.status().busy, true);
  await assert.rejects(
    policy.edit({ operation: "reset", expected_revision: policy.snapshot().revision, reason: "impatient" }),
    /POLICY_SETTLING/,
  );
  release();
  const output = await reply;
  assert.equal(output.result.status, "succeeded");
  assert.match(output.result.status === "succeeded" ? output.result.policy.lastChange : "", /combat\.hide for the session: test/);
  assert.equal(policy.settling, false);
  assert.equal(runner.status().busy, false);
});

test("reconciliation failure still waits for every owner and reports committed policy", async () => {
  const { policy, set } = fixture();
  let released = false;
  policy.onChange(() => {
    throw new Error("owner failure");
  });
  policy.onChange(async () => {
    await Promise.resolve();
    released = true;
  });
  await assert.rejects(set({ combat: { bow: false } }), /reconciliation failed/);
  assert.equal(released, true);
  assert.equal(policy.combat.bow, false);
  assert.equal(policy.settling, false);
});

test("unrelated policy changes preserve active effects, and new connections reject old revisions", async () => {
  const before = DEFAULT_COMBAT_POLICY;
  assert.equal(responsePolicyChanged(before, { ...before, hide: "never" }, "fight"), false);
  assert.equal(responsePolicyChanged(before, { ...before, bow: false }, "hide"), false);
  assert.equal(responsePolicyChanged(before, { ...before, bow: false }, "fight"), true);
  assert.equal(responsePolicyChanged(before, { ...before, critical_health: 5 }, "evade"), true);
  assert.equal(responsePolicyChanged(before, { ...before, evade_safe_range: 24 }, "fight"), false);
  const first = fixture().policy;
  const second = fixture().policy;
  await assert.rejects(
    second.edit({ operation: "reset", expected_revision: first.snapshot().revision, reason: "wrong connection" }),
    /POLICY_REVISION_STALE/,
  );
});

test("a declared quarry lasts exactly as long as the hunt request that declared it", () => {
  const { policy } = fixture();
  assert.deepEqual(policy.quarry, []);
  const hunt = new AbortController();
  const second = new AbortController();
  policy.declareQuarry(hunt.signal, "skeleton");
  policy.declareQuarry(second.signal, "skeleton");
  policy.declareQuarry(hunt.signal, "zombie");
  assert.deepEqual(policy.quarry, ["skeleton"], "one lifetime declares one species, listed once");
  hunt.abort("cancelled");
  assert.deepEqual(policy.quarry, ["skeleton"]);
  second.abort("done");
  assert.deepEqual(policy.quarry, []);
  policy.declareQuarry(second.signal, "skeleton");
  assert.deepEqual(policy.quarry, [], "an ended request cannot declare quarry");
});
