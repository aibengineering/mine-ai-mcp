import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMBAT_POLICY } from "./contract.js";
import {
  combatDecisionEvidence,
  combatResponseExclusions,
  decideCombatResponse,
  type CombatDecisionFacts,
  type CombatPurpose,
} from "./decision.js";
import { decideHostileReflex } from "./reflex-decision.js";

const scene = (): CombatDecisionFacts => ({
  policy: { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" },
  health: 20,
  burning: false,
  hideAllowed: false,
  recoveryAvailable: true,
  weapon: true,
  rangedWeapon: false,
  shield: true,
  fireball: null,
  unreachable: new Set(),
  answeredFights: new Map(),
  answered: new Set(),
  contacts: [
    {
      id: 7,
      name: "piglin",
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
      relationship: { avoid: true, defend: false, attention: "unknown" },
      inContact: true,
      inReach: true,
      defendsOnContact: true,
      ranged: false,
      utility: { inReach: true, visible: true, hasHitUs: false, safeDropGround: true, distance: 2 },
    },
  ],
});

test("prohibiting retreat does not authorize an angry piglin whose victim is unknown", () => {
  const facts = scene();
  const response = decideCombatResponse(
    { ...facts, policy: { ...facts.policy, retreat: false } },
    { kind: "automatic" },
  );
  assert.equal(response.kind, "constrained");
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
});

test("defend_only keeps the explicit quarry while handoff never chooses fresh pursuit", () => {
  const facts = scene();
  const request = decideCombatResponse(facts, {
    kind: "pursuit",
    targetId: 42,
    minimumHealth: facts.policy.engage_min_health,
  });
  assert.equal(request.kind, "fight");
  if (request.kind === "fight") assert.equal(request.targetId, 42);
  assert.equal(decideCombatResponse(facts, { kind: "handoff" }).kind, "evade");
});

test("an exhausted recovery blocks reentry while a permitted enclosure can still secure handoff", () => {
  const facts = { ...scene(), health: 6, hideAllowed: true, answered: new Set(["recovery"]) };
  assert.equal(decideCombatResponse(facts, { kind: "recovery", targetId: 42 }).kind, "constrained");
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
  assert.equal(decideCombatResponse(facts, { kind: "handoff" }).kind, "hide");
});

test("serialized decision inputs retain every scope needed to replay the decision", () => {
  const facts = {
    ...scene(),
    unreachable: new Set([7]),
    answeredFights: new Map([[7, 28]]),
    answered: new Set(["fight", "hide", "recovery"]),
  };
  for (const purpose of [
    { kind: "automatic" },
    { kind: "pursuit", targetId: 42, minimumHealth: 12 },
    { kind: "recovery", targetId: 42 },
    { kind: "handoff" },
  ] satisfies CombatPurpose[]) {
    const decision = decideCombatResponse(facts, purpose);
    const receipt = JSON.parse(JSON.stringify(combatDecisionEvidence(facts, purpose, decision))) as {
      inputs: Omit<CombatDecisionFacts, "unreachable" | "answered" | "answeredFights"> & {
        unreachable: number[];
        answered: string[];
        answeredFights: [number, number][];
      };
      purpose: CombatPurpose;
      decision: ReturnType<typeof decideCombatResponse>;
    };
    assert.deepEqual(receipt.inputs.unreachable, [7]);
    assert.deepEqual(receipt.inputs.answeredFights, [[7, 28]]);
    assert.deepEqual(receipt.inputs.answered, ["fight", "hide", "recovery"]);
    assert.deepEqual(
      decideCombatResponse(
        {
          ...receipt.inputs,
          unreachable: new Set(receipt.inputs.unreachable),
          answeredFights: new Map(receipt.inputs.answeredFights),
          answered: new Set(receipt.inputs.answered),
        },
        receipt.purpose,
      ),
      receipt.decision,
    );
  }
});

test("a failed fight stays excluded at melee reach without resolving its threat or excluding other targets", () => {
  // EnderSeeker 2026-09-11: blocked retreat was forgotten by selection at full
  // health and melee reach, then vetoed by the driver while the creeper remained.
  const facts = scene();
  const creeper = {
    ...facts.contacts[0]!,
    name: "creeper",
    distance: 0.36,
    relationship: { avoid: true, defend: true, attention: "on_sight" as const },
  };
  const blocked = { ...facts, contacts: [creeper], answeredFights: new Map([[7, 28]]) };
  for (const purpose of [
    { kind: "automatic" },
    { kind: "pursuit", targetId: 7, minimumHealth: 12 },
    { kind: "contact_defence", targetId: 7 },
  ] satisfies CombatPurpose[]) {
    const response = decideCombatResponse(blocked, purpose);
    assert.notEqual(response.kind, "none", "failed attempt is not resolved danger");
    assert.notEqual(response.kind, "constrained", "an unanswered withdrawal is still permitted");
    assert.ok(response.kind !== "fight" || response.targetId !== 7, "selection must honor admission's exclusion");
    assert.ok("threats" in response && response.threats.some(({ id }) => id === 7));
  }
  const another = { ...creeper, id: 8, name: "zombie" };
  const response = decideCombatResponse({ ...blocked, contacts: [creeper, another] }, { kind: "automatic" });
  assert.ok(response.kind === "fight" && response.targetId === 8, "failure is target-specific");
  assert.equal(decideCombatResponse({ ...blocked, contacts: [] }, { kind: "automatic" }).kind, "none");
});

test("standing-down evidence separates a retained failure from a prohibited response", () => {
  const facts = { ...scene(), policy: { ...DEFAULT_COMBAT_POLICY, retreat: false, hide: "never" as const } };
  assert.deepEqual(combatResponseExclusions(facts, "no route", new Map([["fight", 17]])), [
    { response: "fight", excluded: { kind: "answered", entry: 17 } },
    { response: "hide", excluded: { kind: "prohibited", field: "hide" } },
    { response: "evade", excluded: { kind: "prohibited", field: "retreat" } },
  ]);
});

const skeletonScene = (): CombatDecisionFacts => ({
  ...scene(),
  contacts: [
    {
      id: 24617,
      name: "skeleton",
      position: { x: 6, y: 64, z: 0 },
      distance: 6,
      relationship: { avoid: true, defend: true, attention: "on_sight" },
      inContact: true,
      inReach: false,
      defendsOnContact: false,
      ranged: true,
      utility: { inReach: false, visible: true, hasHitUs: false, safeDropGround: true, distance: 6 },
    },
  ],
});

test("a hunted species in contact is fought, not withdrawn from, until health rules say otherwise", () => {
  const facts = skeletonScene();
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
  const hunted = decideCombatResponse(facts, { kind: "automatic", quarry: ["skeleton"] });
  assert.equal(hunted.kind, "fight");
  if (hunted.kind === "fight") assert.equal(hunted.targetId, 24617);
  assert.equal(decideCombatResponse(facts, { kind: "automatic", quarry: ["zombie"] }).kind, "evade");
  const hurt = decideCombatResponse({ ...facts, health: 10 }, { kind: "automatic", quarry: ["skeleton"] });
  assert.equal(hurt.kind, "evade");
  if (hurt.kind === "evade") assert.equal(hurt.reason, "hurt");
});

test("a hunted contact whose fight is answered or unreachable leaves the decision to the hunt", () => {
  const facts = skeletonScene();
  const answered = decideCombatResponse(
    { ...facts, answeredFights: new Map([[24617, 3]]) },
    { kind: "automatic", quarry: ["skeleton"] },
  );
  assert.equal(answered.kind, "none");
  const unreachable = decideCombatResponse(
    { ...facts, unreachable: new Set([24617]) },
    { kind: "automatic", quarry: ["skeleton"] },
  );
  assert.equal(unreachable.kind, "none");
  const other = decideCombatResponse({ ...facts, answeredFights: new Map([[24617, 3]]) }, { kind: "automatic" });
  assert.equal(other.kind, "evade");
});

test("a hostile interruption names the decision's reason so the caller can act on it", () => {
  const facts = skeletonScene();
  const directive = decideCombatResponse(facts, { kind: "automatic" });
  const decision = decideHostileReflex({ facts, directive, settling: false, combatOwnsBody: false, entries: [] });
  assert.equal(decision.kind, "respond");
  if (decision.kind === "respond")
    assert.equal(
      decision.reason,
      "[HOSTILE_CONTACT] evade response for skeleton#24617 at 6,64,0 (6 blocks) (withdraw: no permitted attack, or defend_only engagement out of reach).",
    );
  const fight = decideCombatResponse(facts, { kind: "automatic", quarry: ["skeleton"] });
  const fighting = decideHostileReflex({ facts, directive: fight, settling: false, combatOwnsBody: false, entries: [] });
  if (fighting.kind === "respond") assert.equal(fighting.reason, "[HOSTILE_CONTACT] fight response for skeleton#24617 at 6,64,0 (6 blocks).");
});
