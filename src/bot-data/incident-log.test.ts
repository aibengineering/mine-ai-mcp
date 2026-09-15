import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordIncident, writeIncidentArtifact, type IncidentReference } from "./incident-log.js";
import { recordActionRequest, recordActionResponse } from "./action-call-log.js";
import { temporaryBotData } from "../test-support/bot-data.js";

test("retention removes expired and oldest artifacts, preserves other files, and refuses an oversized capture", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "operator-notes.txt"), "keep");
  const save = () =>
    writeIncidentArtifact(directory, "death", null, [Buffer.alloc(60)], null, { days: 5, maxBytes: 100 });
  const first = await save();
  assert.equal(first.artifact.kind, "written");
  if (first.artifact.kind !== "written") return;
  const second = await save();
  assert.equal(second.artifact.kind, "written");
  assert.equal((await readdir(directory)).includes(path.basename(first.artifact.path)), false);
  if (second.artifact.kind !== "written") return;
  await utimes(second.artifact.path, new Date(0), new Date(0));
  await writeIncidentArtifact(directory, "death", null, [Buffer.alloc(1)], null, { days: 5, maxBytes: 100 });
  assert.equal((await readdir(directory)).includes(path.basename(second.artifact.path)), false);
  assert.equal((await readdir(directory)).includes("operator-notes.txt"), true);
  const oversized = await writeIncidentArtifact(directory, "death", null, [Buffer.alloc(101)], null, {
    days: 5,
    maxBytes: 100,
  });
  assert.equal(oversized.artifact.kind, "failed");
});

test("incident references join responses regardless of write order without unread events", () => {
  using data = temporaryBotData();
  for (const early of [true, false]) {
    const requestId = recordActionRequest(data, "bot", {
      actionName: "navigate",
      requestedAt: "now",
      rationale: "test",
      request: {},
    });
    const incident: IncidentReference = {
      incidentId: String(requestId),
      requestId: early ? requestId : null,
      precedingRequestId: early ? null : requestId,
      trigger: "death",
      artifact: { kind: "failed", error: "disk unavailable" },
    };
    if (early) recordIncident(data, incident);
    recordActionResponse(data, {
      requestId,
      respondedAt: "later",
      durationMs: 1,
      status: "succeeded",
      response: { result: { status: "succeeded" } },
    });
    if (!early) recordIncident(data, incident);
    const row = data.read("SELECT response_json FROM action_responses WHERE request_id = ?", requestId)[0]!;
    assert.deepEqual(JSON.parse(String(row.response_json)).incidentReferences, [incident]);
  }
  assert.equal(data.read("SELECT * FROM events").length, 0);
});
