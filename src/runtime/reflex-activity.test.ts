import assert from "node:assert/strict";
import test from "node:test";
import type { ActionRunner } from "../session/action-runner.js";
import type { ReflexActivityObservation } from "../session/progress.js";
import type { CombatDecision } from "../survival/control/combat/contract.js";
import type { SurvivalTransition } from "../survival/control/contract.js";
import { decisionStates, observeReflexActivity } from "./reflex-activity.js";

function harness() {
  const observed: ReflexActivityObservation[] = [];
  let transition: ((event: SurvivalTransition) => void) | null = null;
  let decision: ((event: CombatDecision) => void) | null = null;
  const runner: Pick<ActionRunner, "recordReflexActivity"> = { recordReflexActivity: (observation) => { observed.push(observation); } };
  const stop = observeReflexActivity(
    { onTransition: (observer) => { transition = observer; return () => {}; } },
    { onDecision: (listener) => { decision = listener; return () => {}; } },
    runner,
  );
  return {
    stop,
    transition: (event: SurvivalTransition) => transition?.(event),
    decision: (event: CombatDecision) => decision?.(event),
    drain: () => observed.splice(0).map((entry) => `${entry.kind} ${entry.state.kind}:${entry.state.reflex}/${entry.state.name}${entry.state.exclusion ? ` ${entry.state.exclusion}=${entry.state.detail}` : ""}`),
  };
}

test("a stand-down decision occupies one withheld state per candidate with its exclusion", () => {
  assert.deepEqual(
    decisionStates("hostile", { kind: "stand_down", candidates: [
      { response: "fight", excluded: { kind: "prohibited", field: "melee,bow" } },
      { response: "hide", excluded: { kind: "missing_equipment", item: "food" } },
      { response: "evade", excluded: { kind: "answered", entry: 4 } },
    ] }),
    [
      { kind: "withheld", reflex: "hostile", name: "fight", exclusion: "prohibited", detail: "melee,bow" },
      { kind: "withheld", reflex: "hostile", name: "hide", exclusion: "missing_equipment", detail: "food" },
      { kind: "withheld", reflex: "hostile", name: "evade", exclusion: "answered", detail: "4" },
    ],
  );
  assert.deepEqual(decisionStates("hostile", { kind: "respond", response: "fight", reason: "in reach" }),
    [{ kind: "response", reflex: "hostile", name: "fight", exclusion: null, detail: null }]);
  assert.deepEqual(decisionStates("hostile", { kind: "handled", by: "combat" }), [], "delegation occupies no state");
  assert.deepEqual(decisionStates("hostile", null), []);
});

test("decision changes emit only the states that actually changed, per reflex", () => {
  const h = harness();
  const standDown = (candidates: unknown) => h.transition({ kind: "decision", reflex: "hostile_reflex", evidence: { decision: { kind: "stand_down", candidates } as never, inputs: null } });
  standDown([{ response: "hide", excluded: { kind: "prohibited", field: "hide" } }, { response: "evade", excluded: { kind: "prohibited", field: "retreat" } }]);
  assert.deepEqual(h.drain(), ["entered withheld:hostile_reflex/hide prohibited=hide", "entered withheld:hostile_reflex/evade prohibited=retreat"]);
  standDown([{ response: "hide", excluded: { kind: "prohibited", field: "hide" } }, { response: "evade", excluded: { kind: "answered", entry: 2 } }]);
  assert.deepEqual(h.drain(), ["left withheld:hostile_reflex/evade prohibited=retreat", "entered withheld:hostile_reflex/evade answered=2"], "an unchanged candidate is not re-entered");
  h.transition({ kind: "decision", reflex: "hunger_reflex", evidence: { decision: { kind: "respond", response: "eat", reason: "low" }, inputs: null } });
  assert.deepEqual(h.drain(), ["entered response:hunger_reflex/eat"], "another reflex does not disturb the first");
  h.transition({ kind: "danger", reflex: "hostile_reflex", evidence: { danger: null, missing: null } });
  assert.deepEqual(h.drain(), [], "danger and outcome transitions carry no state");
  h.transition({ kind: "decision", reflex: "hostile_reflex", evidence: { decision: null, inputs: null } });
  assert.deepEqual(h.drain(), ["left withheld:hostile_reflex/hide prohibited=hide", "left withheld:hostile_reflex/evade answered=2"]);
  h.stop();
  assert.deepEqual(h.drain(), ["left response:hunger_reflex/eat"], "stopping closes every occupied state");
});

test("combat phases occupy one state at a time and close when the engagement ends", () => {
  const h = harness();
  h.decision({ kind: "phase", targetId: 7, phase: "approach", completedEffects: 0 });
  h.decision({ kind: "phase", targetId: 7, phase: "swing", completedEffects: 1 });
  h.decision({ kind: "phase", targetId: 7, phase: "approach", completedEffects: 2 });
  assert.deepEqual(h.drain(), [
    "entered combat_phase:combat/approach", "left combat_phase:combat/approach", "entered combat_phase:combat/swing",
    "left combat_phase:combat/swing", "entered combat_phase:combat/approach",
  ]);
  h.decision({ kind: "retarget", from: 7, to: 8 });
  assert.deepEqual(h.drain(), []);
  h.decision({ kind: "engagement", state: "ended", targetId: 8, targetDistance: null, execution: null as never, outcome: "died", observation: null });
  assert.deepEqual(h.drain(), ["left combat_phase:combat/approach"]);
});
