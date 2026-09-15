import assert from "node:assert/strict";
import test from "node:test";
import { recordActionRequest, recordActionResponse } from "./action-call-log.js";
import { temporaryBotData } from "../test-support/bot-data.js";

test("exposes a pending action request until its response is recorded", (t) => {
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });

  const requestId = recordActionRequest(data, "TestBot", {
    actionName: "navigate",
    rationale: "Reach the observed oak tree.",
    requestedAt: "2026-08-24T01:02:03.000Z",
    request: {
      x: 4,
      y: 64,
      z: -2,
      rationale: "Reach the observed oak tree.",
      response_format: "markdown",
    },
  });

  assert.equal(requestId, 1);
  assert.deepEqual(
    data.read(`
      SELECT request.request_id, response.request_id AS response_request_id
      FROM action_requests AS request
      LEFT JOIN action_responses AS response USING (request_id)
    `),
    [{ request_id: 1, response_request_id: null }],
  );

  recordActionResponse(data, {
    requestId,
    respondedAt: "2026-08-24T01:02:04.250Z",
    durationMs: 1_250,
    status: "succeeded",
    response: {
      content: [{ type: "text", text: "Arrived." }],
      structuredContent: { response: { format: "markdown" } },
      isError: false,
    },
  });

  const [stored] = data.read(`
    SELECT
      request.request_id, request.bot_id, request.action_name, request.rationale,
      request.requested_at, request.request_json, response.responded_at,
      response.duration_ms, response.status, response.response_json
    FROM action_requests AS request
    JOIN action_responses AS response USING (request_id)
  `);

  assert.deepEqual(
    {
      ...stored,
      request_json: JSON.parse(String(stored?.request_json)),
      response_json: JSON.parse(String(stored?.response_json)),
    },
    {
      request_id: 1,
      bot_id: "TestBot",
      action_name: "navigate",
      rationale: "Reach the observed oak tree.",
      requested_at: "2026-08-24T01:02:03.000Z",
      responded_at: "2026-08-24T01:02:04.250Z",
      duration_ms: 1_250,
      status: "succeeded",
      request_json: {
        x: 4,
        y: 64,
        z: -2,
        rationale: "Reach the observed oak tree.",
        response_format: "markdown",
      },
      response_json: {
        content: [{ type: "text", text: "Arrived." }],
        structuredContent: { response: { format: "markdown" } },
        isError: false,
      },
    },
  );
});
