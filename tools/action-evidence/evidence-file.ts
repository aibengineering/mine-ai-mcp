/** The package-owned artifact contract shared by evidence capture and presentation. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const capturedCallSchema = z.strictObject({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  response: CallToolResultSchema,
  expectedError: z.string().optional(),
});

export const actionEvidenceSchema = z.strictObject({
  scenario: z.string().min(1),
  minecraftVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  tools: z.array(ToolSchema),
  calls: z.array(capturedCallSchema),
  failure: z.string().optional(),
});

export type ActionEvidence = z.output<typeof actionEvidenceSchema>;

const evidenceDirectory = new URL("../../.mine-labs/evidence/", import.meta.url);
export const actionEvidenceJsonPath = fileURLToPath(new URL("action-evidence.json", evidenceDirectory));
export const actionEvidenceHtmlPath = fileURLToPath(new URL("action-evidence.html", evidenceDirectory));

export async function readActionEvidence(path = actionEvidenceJsonPath): Promise<ActionEvidence> {
  return actionEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
