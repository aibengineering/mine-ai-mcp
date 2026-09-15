import type { SqlBotData } from "./sql-bot-data.js";
import { readRequestIncidents } from "./incident-log.js";

export type ActionCallStatus = "succeeded" | "partial" | "failed" | "cancelled" | "accepted" | "refused" | "pending" | "storage_failed" | "cancellation_requested";

export interface ActionRequestInput {
  readonly actionName: string;
  readonly rationale: string;
  readonly requestedAt: string;
  readonly request: unknown;
}

export interface ActionResponseInput {
  readonly requestId: number;
  readonly respondedAt: string;
  readonly durationMs: number;
  readonly status: ActionCallStatus;
  readonly response: unknown;
}

/** Make one accepted MCP action request visible before its action begins. */
export function recordActionRequest(data: SqlBotData, botId: string, request: ActionRequestInput): number {
  const requestJson = serializeJson(request.request, "request");

  return data.transaction((database) => {
    const inserted = database
      .prepare(
        `INSERT INTO action_requests (bot_id, action_name, rationale, requested_at, request_json)
         VALUES (?, ?, ?, ?, ?)
         RETURNING request_id`,
      )
      .get(botId, request.actionName, request.rationale, request.requestedAt, requestJson) as { request_id: number };
    return inserted.request_id;
  }, { name: "recordActionRequest" });
}

/** Complete one recorded request with the exact MCP response produced for its caller. */
export function recordActionResponse(data: SqlBotData, response: ActionResponseInput): void {
  const responseJson = serializeJson(response.response, "response");
  const incidents = JSON.stringify(readRequestIncidents(data, response.requestId));

  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO action_responses (
           request_id, responded_at, duration_ms, status, response_json
         ) VALUES (?, ?, ?, ?, CASE WHEN ? = '[]' THEN ? ELSE json_set(?, '$.incidentReferences', json(?)) END)`,
      )
      .run(
        response.requestId,
        response.respondedAt,
        response.durationMs,
        response.status,
        incidents,
        responseJson,
        responseJson,
        incidents,
      );
  }, { name: "recordActionResponse", requestId: response.requestId });
}

function serializeJson(value: unknown, field: "request" | "response"): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`Action call ${field} must be JSON-serializable.`);
  }
  return serialized;
}
