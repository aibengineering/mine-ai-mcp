import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeIncidentArtifact, type IncidentReference } from "../bot-data/incident-log.js";
import { IncidentRecorder, type IncidentCapture } from "./incident-recorder.js";

function text(capture: IncidentCapture): string {
  return Buffer.concat(capture.contents).toString();
}
const receipt: IncidentReference = {
  incidentId: "test",
  trigger: "non_entity_damage",
  requestId: 1,
  precedingRequestId: null,
  artifact: { kind: "written", path: "test.jsonl" },
};

test("capture freezes facts and retains the committed plan beyond the history window", async () => {
  const saved: IncidentCapture[] = [];
  const recorder = new IncidentRecorder(
    {},
    async (capture) => {
      saved.push(capture);
      return receipt;
    },
    () => {},
  );
  const facts = { position: { x: 1 } };
  recorder.retainPlan({ planId: "old-but-still-committed" });
  recorder.record("expired", {}, Date.now() - 21_000);
  recorder.record("physics", facts);
  const completion = recorder.capture("operator", 1);
  facts.position.x = 100;
  recorder.record("after", facts);
  await recorder.flush();
  assert.deepEqual(await completion, { kind: "completed", reference: receipt });
  assert.match(text(saved[0]!), /old-but-still-committed/);
  assert.match(text(saved[0]!), /"x":1}/);
  assert.doesNotMatch(text(saved[0]!), /expired|"x":100/);
});

test("fine-grained events retain their facts without duplicating physics context", async () => {
  const saved: IncidentCapture[] = [];
  const recorder = new IncidentRecorder({}, async (capture) => {
    saved.push(capture);
    return receipt;
  }, () => {}, undefined, () => ({ survival: { owner: "combat", policy: "unchanged" } }));
  recorder.record("physics", { health: 20 });
  recorder.record("navigation", { event: { kind: "step_started", stepId: "step-1" } });
  recorder.record("execution", { event: { phase: "guard" } });
  recorder.record("survival_receipt", { event: { kind: "response" } });
  recorder.record("combat_decision", { evidence: { stage: "guard_admitted" } });
  recorder.record("hit", { source: "arrow" });
  await recorder.capture("operator", null);
  const records = text(saved[0]!).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.find((r) => r.kind === "physics").survival.owner, "combat");
  assert.equal(records.find((r) => r.kind === "hit").survival.owner, "combat");
  assert.equal(records.find((r) => r.kind === "navigation").event.stepId, "step-1");
  assert.equal(records.find((r) => r.kind === "execution").event.phase, "guard");
  assert.equal(records.find((r) => r.kind === "execution").survival, undefined);
  assert.equal(records.find((r) => r.kind === "survival_receipt").event.kind, "response");
  assert.equal(records.find((r) => r.kind === "survival_receipt").survival, undefined);
  assert.equal(records.find((r) => r.kind === "combat_decision").evidence.stage, "guard_admitted");
  assert.equal(records.find((r) => r.kind === "combat_decision").survival, undefined);
});

test("byte pressure and slow storage are bounded and disclosed", async () => {
  const saved: IncidentCapture[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = new IncidentRecorder(
    {},
    async (capture) => {
      saved.push(capture);
      if (saved.length === 1) await blocked;
      return receipt;
    },
    () => {},
    { durationMs: 20_000, bytes: 200 },
  );
  for (let i = 0; i < 5; i++) recorder.record("physics", { payload: "x".repeat(90) });
  recorder.capture("non_entity_damage", 1);
  recorder.record("trigger", { trigger: "disconnect" });
  const replaced = recorder.capture("operator", 2);
  recorder.record("trigger", { trigger: "death" });
  const kept = recorder.capture("death", 3);
  assert.deepEqual(await replaced, { kind: "coalesced" });
  assert.equal(recorder.status().pendingCaptures, 2);
  assert.equal(saved.length, 1);
  release();
  await recorder.flush();
  assert.equal((await kept).kind, "completed");
  assert.equal(saved.length, 2);
  assert.equal(saved[1]!.trigger, "death");
  assert.match(text(saved[1]!), /"coalescedCaptures":1/);
  assert.match(text(saved[0]!), /"byteBudgetOmissions":\{"records":4,/);
});

test("each capture returns its own published reference, and writer failures settle explicitly", async () => {
  const recorder = new IncidentRecorder(
    {},
    async (capture) => {
      if (capture.requestId === 3) throw new Error("storage unavailable");
      return { ...receipt, requestId: capture.requestId };
    },
    () => {},
  );
  const first = recorder.capture("operator", 1);
  const second = recorder.capture("operator", 2);
  assert.deepEqual(await first, { kind: "completed", reference: { ...receipt, requestId: 1 } });
  assert.deepEqual(await second, { kind: "completed", reference: { ...receipt, requestId: 2 } });
  assert.deepEqual(await recorder.capture("operator", 3), { kind: "failed", error: "Error: storage unavailable" });
  assert.equal(recorder.status().writeFailures, 1);
});

test("artifact persistence returns an explicit failed receipt without rejecting", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-write-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = [Buffer.from('{"kind":"incident"}\n')];
  const written = await writeIncidentArtifact(directory, "death", 8, contents);
  assert.equal(written.artifact.kind, "written");
  if (written.artifact.kind === "written")
    assert.equal(await readFile(written.artifact.path, "utf8"), contents[0]!.toString());
  const file = path.join(directory, "not-a-directory");
  await writeFile(file, "occupied");
  const failed = await writeIncidentArtifact(file, "disconnect", 8, contents);
  assert.equal(failed.artifact.kind, "failed");
});

test("fast recurring damage writes checkpoint once per history window without suppressing terminal or manual captures", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const saved: IncidentCapture[] = [];
  const recorder = new IncidentRecorder(
    {},
    async (capture) => {
      saved.push(capture);
      return { ...receipt, trigger: capture.trigger };
    },
    () => {},
  );
  for (let hit = 0; hit < 53; hit++) {
    now = 100_000 + hit * 500;
    recorder.record("trigger", { trigger: "non_entity_damage", hit });
    recorder.record("packet", { hit });
    const result = await recorder.capture("non_entity_damage", 1);
    assert.equal(result.kind, hit === 0 || hit === 40 ? "completed" : "coalesced");
  }
  assert.equal(saved.length, 2);
  assert.equal(recorder.status().coalescedCaptures, 51);
  for (const trigger of ["operator", "death", "disconnect"] as const) {
    assert.equal((await recorder.capture(trigger, 1)).kind, "completed");
  }
  assert.deepEqual(
    saved.map((capture) => capture.trigger),
    ["non_entity_damage", "non_entity_damage", "operator", "death", "disconnect"],
  );
  assert.match(text(saved[3]!), /"kind":"packet".*"hit":52/);
  assert.match(text(saved[3]!), /"trigger":"non_entity_damage","hit":52/);
  assert.doesNotMatch(text(saved[3]!), /"hit":0}/);
});

test("failed damage writes permit immediate retry and queued damage uses the completed checkpoint", async () => {
  let attempts = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = new IncidentRecorder(
    {},
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("unavailable");
      if (attempts === 2) return { ...receipt, artifact: { kind: "failed" as const, error: "unavailable" } };
      await blocked;
      return receipt;
    },
    () => {},
  );
  assert.equal((await recorder.capture("non_entity_damage", 1)).kind, "failed");
  await recorder.capture("non_entity_damage", 1);
  const writing = recorder.capture("non_entity_damage", 1);
  const pending = recorder.capture("non_entity_damage", 1);
  release();
  assert.equal((await writing).kind, "completed");
  assert.equal((await pending).kind, "coalesced");
  assert.equal(attempts, 3);
  assert.equal(recorder.status().writeFailures, 2);
  assert.equal(recorder.status().coalescedCaptures, 1);
});

test("slow persistence does not defer the next damage snapshot beyond its captured history window", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved: IncidentCapture[] = [];
  const recorder = new IncidentRecorder(
    {},
    async (capture) => {
      saved.push(capture);
      if (saved.length === 1) await blocked;
      return receipt;
    },
    () => {},
  );
  recorder.record("packet", { checkpoint: "first" });
  const first = recorder.capture("non_entity_damage", 1);
  now += 20_000;
  recorder.record("packet", { checkpoint: "next" });
  const next = recorder.capture("non_entity_damage", 1);
  now += 5_000;
  release();
  assert.equal((await first).kind, "completed");
  assert.equal((await next).kind, "completed");
  assert.equal(saved.length, 2);
  assert.match(text(saved[1]!), /"checkpoint":"next"/);
  assert.equal((await recorder.capture("non_entity_damage", 1)).kind, "coalesced");
  now = 140_000;
  assert.equal((await recorder.capture("non_entity_damage", 1)).kind, "completed");
  assert.equal(saved.length, 3);
});
