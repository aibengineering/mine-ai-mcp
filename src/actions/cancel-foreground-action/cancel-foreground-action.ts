import type { ForegroundCancellation } from "../../session/action-runner.js";
import { defineAction } from "../action.js";
import {
  parseCancelForegroundActionRequest,
  CANCEL_FOREGROUND_ACTION,
  CANCEL_FOREGROUND_ACTION_DESCRIPTION,
  cancelForegroundActionInputSchema,
  cancelForegroundActionResultSchema,
  type CancelForegroundActionResult,
} from "./contract.js";

export function formatCancelForegroundActionResult(result: CancelForegroundActionResult): string {
  const cancellation = result.cancellation;
  return cancellation.kind === "idle"
    ? `No foreground action was running. Reason recorded: ${cancellation.reason}`
    : `Cancellation requested for ${cancellation.action}, which had been running since ${cancellation.startedAt}. Reason: ${cancellation.reason}`;
}

/** This control action deliberately bypasses the foreground lock it is able to cancel. */
export function createCancelForegroundAction(cancelActive: (reason: string) => ForegroundCancellation) {
  return defineAction({
    name: CANCEL_FOREGROUND_ACTION,
    description: CANCEL_FOREGROUND_ACTION_DESCRIPTION,
    inputSchema: cancelForegroundActionInputSchema,
    resultSchema: cancelForegroundActionResultSchema,
    formatResult: formatCancelForegroundActionResult,
    execution: { kind: "control" },
    annotations: {
      title: CANCEL_FOREGROUND_ACTION,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    parse: parseCancelForegroundActionRequest,
    execute: async (request) => ({ status: "succeeded", cancellation: cancelActive(request.reason) }),
  });
}
