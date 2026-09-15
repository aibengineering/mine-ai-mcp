import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionScope } from "../../../execution/execution-scope.js";
import { outranksReflex } from "../priority.js";
import { CombatExecution } from "./execution.js";
import { CombatProgress } from "./progress.js";

test("an interrupted nested guard restores its owning effect and releases its phase", async () => {
  using trace = new ExecutionScope({ bot: "CombatTest", operation: "combat", targetId: 42 });
  const execution = new CombatExecution(trace);
  await execution.run("approach", async () => {
    execution.tick();
    await assert.rejects(
      execution.run("guard", async () => {
        execution.tick();
        assert.equal(execution.snapshot(0).phase, "guard");
        assert.equal(execution.snapshot(0).phaseTicks, 1);
        throw new Error("cancelled");
      }),
      /cancelled/,
    );
    assert.equal(execution.snapshot(0).phase, "approach");
    assert.equal(execution.snapshot(0).phaseTicks, 2);
  });
  assert.equal(execution.snapshot(0).phase, "approach");
});

test("a protected hold reports one phase and its full elapsed time across decision ticks", async () => {
  using trace = new ExecutionScope({ bot: "CombatTest", operation: "combat", targetId: 42 });
  const phases: string[] = [];
  const execution = new CombatExecution(trace, (phase) => phases.push(phase));
  for (let tick = 0; tick < 300; tick++) await execution.run("hold", async () => execution.tick());
  assert.deepEqual(phases, ["hold"]);
  assert.equal(execution.snapshot(0).phaseTicks, 300);
  await execution.run("swing", async () => execution.tick());
  assert.deepEqual(phases, ["hold", "swing"]);
  assert.equal(execution.snapshot(1).phaseTicks, 1);
});

test("phase cycling and completed swings cannot hide an idle engagement", async () => {
  using trace = new ExecutionScope({ bot: "CombatTest", operation: "combat", targetId: 42 });
  const execution = new CombatExecution(trace);
  const start = execution.progress.snapshot().startedAt;
  execution.progress.observe(20, start);
  for (let tick = 0; tick < 300; tick++) {
    await execution.run(tick % 2 ? "guard" : "hold", async () => execution.tick());
  }
  assert.equal(execution.progress.observe(20, start + 15_000), "waiting");
  assert.equal(execution.snapshot(300).completedEffects, 300);
  assert.equal(execution.snapshot(300).progress.confirmedTargetHits, 0);
  assert.deepEqual(execution.snapshot(300).phaseHistory, { hold: 150, guard: 150 });
});

test("replans, cell oscillation, guard refresh and healing do not reset objective inactivity", () => {
  const progress = new CombatProgress(0);
  progress.observe(20, 0);
  progress.milestone("route_step", "1,64,0", 1000);
  assert.equal(progress.observe(20, 1000), "progress");
  progress.milestone("route_step", "2,64,0", 2000);
  progress.observe(20, 2000);
  for (let at = 3000; at < 17000; at += 1000) {
    progress.milestone("route_step", at % 2000 ? "1,64,0" : "2,64,0", at);
    progress.volleyFinished();
    progress.observe(20, at);
  }
  assert.equal(progress.observe(20, 17000), "waiting");
  assert.equal(progress.observe(18, 18000), "stall");
  assert.equal(progress.observe(19, 19000), null);
  assert.equal(progress.snapshot(19000).recoveredHealth, 1);
  assert.equal(progress.snapshot(19000).inactiveMs, 17000);
  assert.equal(progress.snapshot(19000).completedVolleys, 14);
  assert.equal(progress.observe(20, 19500), null);
  assert.equal(progress.snapshot(19500).state, "waiting", "healed damage must not remain labelled as a current stall");
  progress.confirmedHit(false, 20000);
  assert.equal(progress.observe(19, 20000), null, "incidental defence does not mean the target was reached");
  progress.confirmedHit(true, 21000);
  assert.equal(progress.observe(19, 21000), "resumed");
  assert.equal(progress.snapshot(21000).inactiveMs, 0);
  assert.equal(progress.snapshot(21000).confirmedTargetHits, 1);
  assert.equal(progress.observe(17, 26000), "stall");
});

test("reflex precedence is independent of registration order and never treats foreground names as reflexes", () => {
  assert.equal(outranksReflex("fire_reflex", "breath_reflex"), true);
  assert.equal(outranksReflex("breath_reflex", "hostile_reflex"), true);
  assert.equal(outranksReflex("hostile_reflex", "hunger_reflex"), true);
  assert.equal(outranksReflex("hunger_reflex", "hostile_reflex"), false);
  assert.equal(outranksReflex("hostile_reflex", "hostile_reflex"), false);
  assert.equal(outranksReflex("fire_reflex", "collect_block"), false);
});
