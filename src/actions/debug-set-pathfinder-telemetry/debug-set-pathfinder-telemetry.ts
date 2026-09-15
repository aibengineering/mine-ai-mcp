import type { NavigationRuntime } from "../../navigation/index.js";
import { defineAction } from "../action.js";
import {
  DEBUG_SET_PATHFINDER_TELEMETRY,
  DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION,
  debugSetPathfinderTelemetryInputSchema,
  debugSetPathfinderTelemetryResultSchema,
  parseDebugSetPathfinderTelemetryRequest,
  type DebugSetPathfinderTelemetryResult,
} from "./contract.js";

type WriteTelemetryLine = (line: string) => void;

export function formatDebugSetPathfinderTelemetryResult(result: DebugSetPathfinderTelemetryResult): string {
  return `Pathfinder telemetry is ${result.telemetry.enabled ? "enabled" : "disabled"}; events are written to MCP host stdout.`;
}

/** Define the opt-in switch whose subscription lives for this attached Pathfinder. */
export function createDebugSetPathfinderTelemetryAction(
  pathfinder: Pick<NavigationRuntime, "onEvent">,
  writeLine: WriteTelemetryLine = (line) => process.stdout.write(`${line}\n`),
) {
  let unsubscribe: (() => void) | null = null;

  return defineAction({
    name: DEBUG_SET_PATHFINDER_TELEMETRY,
    description: DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION,
    inputSchema: debugSetPathfinderTelemetryInputSchema,
    resultSchema: debugSetPathfinderTelemetryResultSchema,
    formatResult: formatDebugSetPathfinderTelemetryResult,
    execution: { kind: "control" },
    annotations: {
      title: DEBUG_SET_PATHFINDER_TELEMETRY,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    parse: parseDebugSetPathfinderTelemetryRequest,
    execute: async (request) => {
      if (request.enabled && unsubscribe === null) {
        unsubscribe = pathfinder.onEvent((event) => {
          try {
            writeLine(`[mine-ai-mcp] pathfinder_event ${JSON.stringify(event)}`);
          } catch (cause) {
            process.stderr.write(
              `[mine-ai-mcp] Could not write Pathfinder telemetry: ${cause instanceof Error ? cause.message : String(cause)}\n`,
            );
          }
        });
      } else if (!request.enabled && unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      return {
        status: "succeeded",
        telemetry: { enabled: unsubscribe !== null, destination: "mcp_host_stdout" as const },
      };
    },
  });
}
