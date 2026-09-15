import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const DEBUG_SET_PATHFINDER_TELEMETRY = "debug_set_pathfinder_telemetry" as const;
export const DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION =
  "Debug only: enable or disable JSON Pathfinder events in the MCP host stdout log. This action is absent unless debug actions are explicitly enabled and remains callable while a foreground action is busy.";

export const debugSetPathfinderTelemetryInputSchema = z.strictObject({
  enabled: z.boolean().describe("Whether Pathfinder events should be written to the MCP host log."),
});

export const debugSetPathfinderTelemetryResultSchema = actionResultSchema({
  telemetry: z.strictObject({
    enabled: z.boolean(),
    destination: z.literal("mcp_host_stdout"),
  }),
});

export type DebugSetPathfinderTelemetryRequest = z.output<typeof debugSetPathfinderTelemetryInputSchema>;
export type DebugSetPathfinderTelemetryResult = z.output<typeof debugSetPathfinderTelemetryResultSchema>;
export type DebugSetPathfinderTelemetryOutput = ActionOutput<
  typeof DEBUG_SET_PATHFINDER_TELEMETRY,
  DebugSetPathfinderTelemetryResult
>;

export function parseDebugSetPathfinderTelemetryRequest(raw: unknown): DebugSetPathfinderTelemetryRequest {
  return debugSetPathfinderTelemetryInputSchema.parse(raw ?? {});
}
