import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import express from "express";
import { incidentCaptureResultSchema, type IncidentCaptureResult } from "../bot-data/incident-log.js";
import { registerIncidentCaptureRoute } from "./incident-route.js";

/**
 * A runtime that answers only `captureIncident`, from whatever request owns the
 * body when it is asked. Any other property read fails the test, so the route
 * cannot submit work, take controls or touch the notification state.
 */
function runtime(capture: () => Promise<IncidentCaptureResult>) {
  let captures = 0;
  const target = {
    captureIncident: () => {
      captures += 1;
      return capture();
    },
  };
  const guarded = new Proxy(target, {
    get(object, property) {
      if (property !== "captureIncident") throw new Error(`The capture route read runtime.${String(property)}.`);
      return Reflect.get(object, property);
    },
  });
  return { runtime: guarded, captures: () => captures };
}

async function route(t: TestContext, capture: () => Promise<IncidentCaptureResult>) {
  const fake = runtime(capture);
  const app = express();
  registerIncidentCaptureRoute(app, fake.runtime);
  const listener = createServer(app);
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    listener.closeAllConnections();
    await closed;
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const post = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/diagnostics/incidents`, { method: "POST" });
    return { status: response.status, body: incidentCaptureResultSchema.parse(await response.json()) };
  };
  return { post, captures: fake.captures };
}

function written(requestId: number | null, precedingRequestId: number | null): IncidentCaptureResult {
  return {
    kind: "completed",
    reference: {
      incidentId: `incident-${requestId ?? "after"}-${precedingRequestId ?? "none"}`,
      trigger: "operator",
      requestId,
      precedingRequestId,
      artifact: { kind: "written", path: `/incidents/${requestId ?? precedingRequestId}.jsonl` },
    },
  };
}

// flat/evidence/operator-capture: an operator POST during a navigate wrote an
// artifact linked to the running request, and a second POST after it returned
// was linked to it only as the preceding request; the runtime's notifications
// were unchanged and the route itself took no action.
test("an operator capture publishes the runtime's request linkage during and after a request", async (t) => {
  let owner: { requestId: number | null; precedingRequestId: number | null } = { requestId: 7, precedingRequestId: 6 };
  const { post, captures } = await route(t, async () => written(owner.requestId, owner.precedingRequestId));

  const during = await post();
  assert.equal(during.status, 200);
  assert.deepEqual(during.body, written(7, 6));

  // The request returns; the next capture belongs to no request.
  owner = { requestId: null, precedingRequestId: 7 };
  const after = await post();
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, written(null, 7));
  assert.equal(captures(), 2, "Each POST is one capture, and nothing else.");
});

test("a coalesced or unwritten capture is reported as such, never as success", async (t) => {
  const results: IncidentCaptureResult[] = [
    { kind: "coalesced" },
    { kind: "failed", error: "recorder closed" },
    {
      kind: "completed",
      reference: {
        incidentId: "unwritten",
        trigger: "operator",
        requestId: 3,
        precedingRequestId: null,
        artifact: { kind: "failed", error: "ENOSPC" },
      },
    },
  ];
  const { post } = await route(t, async () => results.shift()!);
  assert.deepEqual(await post(), { status: 409, body: { kind: "coalesced" } });
  assert.deepEqual(await post(), { status: 500, body: { kind: "failed", error: "recorder closed" } });
  const unwritten = await post();
  assert.equal(unwritten.status, 500);
  assert.equal(unwritten.body.kind === "completed" && unwritten.body.reference.artifact.kind, "failed");
});
