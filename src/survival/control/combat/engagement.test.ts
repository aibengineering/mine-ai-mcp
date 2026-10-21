import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import type { CombatDecisionFacts } from "../../policy/combat/decision.js";
import type { CombatOutcome } from "./contract.js";

import { runEngagement } from "./engagement.js";

const result = (kind: "cancelled" | "died", attacks: number): CombatOutcome => ({
  kind,
  targetId: 7,
  attacks,
  stylesUsed: ["melee"],
  weaponsUsed: ["iron_sword"],
  shieldRaisedSwings: 0,
  projectileGuards: 0,
  explosions: 0,
});

test("a health stop recovers and continues the same target with accumulated evidence", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 20 }) as unknown as Bot;
  const request = new AbortController();
  const transitions: string[] = [];
  const outcome = await runEngagement(request.signal, {
    ...operations(bot),
    fight: async () => {
      transitions.push("fight");
      if (transitions.length === 1) {
        bot.health = 11;
        bot.emit("health");

        assert.equal(request.signal.aborted, false);
        return {
          ...result("cancelled", 2),
          kind: "response_required",
          observation: "Health boundary selected recovery.",
        };
      }
      return result("died", 3);
    },
    recover: async () => {
      transitions.push("recover");
      bot.health = 18;
      return { kind: "recovered" };
    },
  });
  assert.deepEqual(transitions, ["fight", "recover", "fight"]);
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 5);
  assert.equal(bot.listenerCount("health"), 0);
});

test("blocked recovery reports its capability rather than retrying a wounded fight", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 7 }) as unknown as Bot;
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot),
    fight: async () => {
      throw new Error("A wounded fight must not start.");
    },
    recover: async () => ({ kind: "blocked", observation: "No food remains and hunger cannot regenerate health." }),
  });
  assert.equal(outcome.kind, "capability_blocked");
  if (outcome.kind !== "capability_blocked") throw new Error("Expected recovery limitation.");
  assert.equal(outcome.reason, "recovery");
  assert.match(outcome.observation, /No food/);
});

test("death during recovery remains death rather than a resource limitation", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 7 }) as unknown as Bot;
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot),
    fight: async () => {
      throw new Error("A dead bot cannot resume fighting.");
    },
    recover: async () => {
      bot.health = 0;
      return { kind: "blocked", observation: "Shelter construction was interrupted." };
    },
  });
  assert.equal(outcome.kind, "bot_died");
});

test("caller cancellation never starts a recovery retry", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 20 }) as unknown as Bot;
  const request = new AbortController();
  const outcome = await runEngagement(request.signal, {
    ...operations(bot),
    fight: async () => {
      request.abort("user cancelled");
      return result("cancelled", 1);
    },
    recover: async () => {
      throw new Error("Cancellation is terminal.");
    },
  });
  assert.equal(outcome.kind, "cancelled");
});

test("recovery uses the caller's policy health threshold", async () => {
  const bot = Object.assign(new EventEmitter(), { health: 15 }) as unknown as Bot;
  const transitions: string[] = [];
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot, 19),
    recover: async () => {
      transitions.push("recover");
      bot.health = 19;
      return { kind: "recovered" };
    },
    fight: async () => {
      transitions.push("fight");
      assert.equal(bot.health, 19);
      return result("died", 1);
    },
  });
  assert.deepEqual(transitions, ["recover", "fight"]);
  assert.equal(outcome.kind, "died");
});

for (const cleanupFails of [false, true]) {
  test(`cancelling recovery ${cleanupFails ? "preserves a cleanup failure" : "returns cancelled after release"}`, async () => {
    const bot = Object.assign(new EventEmitter(), { health: 7 }) as unknown as Bot;
    const request = new AbortController();
    const failure = new Error("Physical cleanup failed.");
    const pending = runEngagement(request.signal, {
      ...operations(bot),
      fight: async () => {
        throw new Error("Recovery must precede fighting.");
      },
      recover: async () => {
        request.abort("Combat policy changed.");
        if (cleanupFails) throw failure;
        request.signal.throwIfAborted();
        return { kind: "recovered" };
      },
    });
    if (cleanupFails) await assert.rejects(pending, failure);
    else assert.equal((await pending).kind, "cancelled");
  });
}

function operations(bot: Bot, minimumHealth = 12) {
  return {
    purpose: { kind: "pursuit", targetId: 7, minimumHealth } as const,
    observe: (): CombatDecisionFacts => ({
      policy: DEFAULT_COMBAT_POLICY,
      health: bot.health,
      burning: false,
      hideAllowed: true,
      recoveryAvailable: true,
      weapon: true,
      rangedWeapon: false,
      shield: true,
      contacts: [],
      fireball: null,
      unreachable: new Set(),
      answeredFights: new Map(),
      answered: new Set(),
    }),
    record: () => {},
    deflect: async () => {
      throw new Error("No fireball in this fixture.");
    },
  };
}

test("the selected deflection executes before the quarry fight", async () => {
  const bot = { health: 20 } as Bot;
  const base = operations(bot);
  let fireball = true;
  const effects: string[] = [];
  const outcome = await runEngagement(new AbortController().signal, {
    ...base,
    observe: () => ({
      ...base.observe(),
      fireball: fireball ? { id: 99, name: "fireball", position: { x: 1, y: 65, z: 0 }, distance: 1 } : null,
    }),
    deflect: async (id) => {
      assert.equal(id, 99);
      effects.push("deflect");
      fireball = false;
    },
    fight: async () => {
      effects.push("fight");
      return result("died", 1);
    },
    recover: async () => {
      throw new Error("No recovery selected.");
    },
  });
  assert.equal(outcome.kind, "died");
  assert.deepEqual(effects, ["deflect", "fight"]);
});

test("an attacker still on the bot after impossible recovery is fought where it stands", async () => {
  // combat-proof7 2026-10-20T23-14-14-751Z: the Cave pen at 13 health, with
  // no blocks, no pickaxe and no regeneration, could neither shelter nor
  // heal. Its engagement handed back a recovery limit while the skeleton it
  // was fighting kept shooting, and it ended at 5.
  const bot = Object.assign(new EventEmitter(), { health: 9 }) as unknown as Bot;
  const base = operations(bot);
  const skeleton = {
    id: 7,
    name: "skeleton",
    position: { x: 14, y: -60, z: 2 },
    distance: 11,
    relationship: { avoid: true, defend: true, attention: "observed_attack" as const },
    inContact: true,
    inReach: false,
    defendsOnContact: false,
    ranged: true,
    utility: { inReach: false, visible: true, hasHitUs: true, safeDropGround: true, distance: 11 },
  };
  const effects: string[] = [];
  const outcome = await runEngagement(new AbortController().signal, {
    ...base,
    observe: () => ({ ...base.observe(), contacts: [skeleton] }),
    recover: async () => {
      effects.push("recover");
      return { kind: "blocked", observation: "Nothing below the bot could be dug and nothing could be placed." };
    },
    fight: async (options) => {
      effects.push(options?.defending ? "defend" : "fight");
      return result("died", 4);
    },
  });
  assert.deepEqual(effects, ["recover", "defend"]);
  assert.equal(outcome.kind, "died");
});
