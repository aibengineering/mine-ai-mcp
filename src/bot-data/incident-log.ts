import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SqlBotData } from "./sql-bot-data.js";

export const incidentTriggerSchema = z.enum([
  "non_entity_damage",
  "death",
  "disconnect",
  "runtime_closed",
  "operator",
  "execution_slice_exhausted",
  "runtime_unresponsive",
  "runtime_exited",
  "combat_waiting",
]);
export type IncidentTrigger = z.output<typeof incidentTriggerSchema>;
export const incidentReferenceSchema = z.strictObject({
  incidentId: z.string(),
  trigger: incidentTriggerSchema,
  requestId: z.number().int().positive().nullable(),
  /** Context when the failure arrives after a call returned; this is not causal attribution. */
  precedingRequestId: z.number().int().positive().nullable(),
  artifact: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("written"), path: z.string() }),
    z.strictObject({ kind: z.literal("failed"), error: z.string() }),
  ]),
});
export type IncidentReference = z.output<typeof incidentReferenceSchema>;

export const incidentCaptureResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed"), reference: incidentReferenceSchema }),
  z.strictObject({ kind: z.literal("coalesced") }),
  z.strictObject({ kind: z.literal("failed"), error: z.string() }),
]);
export type IncidentCaptureResult = z.output<typeof incidentCaptureResultSchema>;

export interface IncidentRetention {
  readonly days: number;
  readonly maxBytes: number;
}
// Match the play profile's trace defaults. Hosts pass their configured values.
export const DEFAULT_INCIDENT_RETENTION: IncidentRetention = { days: 5, maxBytes: 67_108_864 };

/** Bound this directory's UUID-named artifacts by age and total bytes, oldest first. */
export async function pruneIncidentArtifacts(
  directory: string,
  retention: IncidentRetention,
  incomingBytes = 0,
): Promise<void> {
  const names = await readdir(directory);
  const files = await Promise.all(
    names
      .filter((name) => /^[0-9a-f-]{36}\.jsonl$/.test(name))
      .map(async (name) => {
        const file = path.resolve(directory, name);
        const info = await stat(file);
        return { file, bytes: info.size, atMs: info.mtimeMs };
      }),
  );
  files.sort((a, b) => a.atMs - b.atMs);
  let bytes = files.reduce((sum, file) => sum + file.bytes, incomingBytes);
  const cutoff = Date.now() - retention.days * 86_400_000;
  for (const file of files) {
    if (file.atMs >= cutoff && bytes <= retention.maxBytes) break;
    await unlink(file.file);
    bytes -= file.bytes;
  }
}

/** Artifact files hold bulky history; bot-data keeps receipts even after retention expires. */
export async function writeIncidentArtifact(
  directory: string,
  trigger: IncidentTrigger,
  requestId: number | null,
  contents: readonly Uint8Array[],
  precedingRequestId: number | null = null,
  retention: IncidentRetention = DEFAULT_INCIDENT_RETENTION,
): Promise<IncidentReference> {
  const incidentId = randomUUID();
  try {
    await mkdir(directory, { recursive: true });
    const bytes = contents.reduce((sum, content) => sum + content.byteLength, 0);
    if (bytes > retention.maxBytes)
      throw new Error(`Incident needs ${bytes} bytes; traceMaxBytes is ${retention.maxBytes}.`);
    await pruneIncidentArtifacts(directory, retention, bytes);
    const file = path.resolve(directory, `${incidentId}.jsonl`);
    await writeFile(file, Buffer.concat(contents), { flag: "wx" });
    return { incidentId, trigger, requestId, precedingRequestId, artifact: { kind: "written", path: file } };
  } catch (cause) {
    return {
      incidentId,
      trigger,
      requestId,
      precedingRequestId,
      artifact: { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) },
    };
  }
}

/** Developer evidence never creates an unread gameplay event. Writes may finish after the response. */
export function recordIncident(data: SqlBotData, reference: IncidentReference): void {
  data.transaction((database) => {
    database
      .prepare(
        `INSERT INTO action_incidents (incident_id, request_id, preceding_request_id, reference_json)
      VALUES (?, ?, ?, ?)`,
      )
      .run(reference.incidentId, reference.requestId, reference.precedingRequestId, JSON.stringify(reference));
    const relatedId = reference.requestId ?? reference.precedingRequestId;
    if (relatedId !== null)
      database
        .prepare(
          `UPDATE action_responses SET response_json =
      json_set(response_json, '$.incidentReferences', json((SELECT json_group_array(json(reference_json))
        FROM action_incidents WHERE request_id = ? OR preceding_request_id = ?))) WHERE request_id = ?`,
        )
        .run(relatedId, relatedId, relatedId);
  }, { name: "recordIncident" });
}

export function readRequestIncidents(data: SqlBotData, requestId: number): IncidentReference[] {
  return data
    .read(
      "SELECT reference_json FROM action_incidents WHERE request_id = ? OR preceding_request_id = ? ORDER BY rowid",
      requestId,
      requestId,
    )
    .map((row) => incidentReferenceSchema.parse(JSON.parse(String(row.reference_json))));
}
