import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";

export const DEBUG_EXECUTE_JAVASCRIPT = "debug_execute_javascript" as const;

export const DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION =
  "Debug only: execute an async JavaScript function body inside this MCP host with the live Mineflayer bot, Vec3, and a captured console in scope. Use return to expose a value. This unrestricted tool can mutate the world and is absent unless explicitly enabled for the configured Mine AI MCP bot.";

export const DEBUG_CODE_MAX_CHARS = 32_768;
export const DEBUG_RENDERED_VALUE_MAX_CHARS = 32_768;
export const DEBUG_LOG_MAX_LINES = 100;
export const DEBUG_LOG_MAX_CHARS = 32_768;

export const debugExecuteJavaScriptInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1)
    .max(DEBUG_CODE_MAX_CHARS)
    .describe(
      "Async JavaScript function body. The live `bot`, Vec3 constructor, and captured `console` are in scope; top-level await is supported. Use `return` to expose a value.",
    ),
});

export const debugExecutionEvidenceSchema = z.strictObject({
  value: z.string().max(DEBUG_RENDERED_VALUE_MAX_CHARS),
  logs: z.array(z.string()).max(DEBUG_LOG_MAX_LINES),
});

export const debugExecuteJavaScriptResultSchema = actionResultSchema({
  execution: debugExecutionEvidenceSchema,
});

export const debugExecuteJavaScriptAnnotations = {
  title: DEBUG_EXECUTE_JAVASCRIPT,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export type DebugExecuteJavaScriptInput = z.input<typeof debugExecuteJavaScriptInputSchema>;
export type DebugExecuteJavaScriptRequest = z.output<typeof debugExecuteJavaScriptInputSchema>;
export type DebugExecuteJavaScriptResult = z.output<typeof debugExecuteJavaScriptResultSchema>;
export type DebugExecuteJavaScriptOutput = ActionOutput<
  typeof DEBUG_EXECUTE_JAVASCRIPT,
  DebugExecuteJavaScriptResult
>;

export function parseDebugExecuteJavaScriptRequest(raw: unknown): DebugExecuteJavaScriptRequest {
  return debugExecuteJavaScriptInputSchema.parse(raw);
}
