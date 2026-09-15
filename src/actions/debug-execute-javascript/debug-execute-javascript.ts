import { executionCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { formatWithOptions, inspect } from "node:util";
import { Vec3 } from "vec3";
import { defineAction } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  DEBUG_EXECUTE_JAVASCRIPT,
  DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION,
  DEBUG_LOG_MAX_CHARS,
  DEBUG_LOG_MAX_LINES,
  DEBUG_RENDERED_VALUE_MAX_CHARS,
  debugExecuteJavaScriptAnnotations,
  debugExecuteJavaScriptInputSchema,
  debugExecuteJavaScriptResultSchema,
  parseDebugExecuteJavaScriptRequest,
  type DebugExecuteJavaScriptRequest,
  type DebugExecuteJavaScriptResult,
} from "./contract.js";

interface CapturedConsole {
  readonly log: (...values: unknown[]) => void;
  readonly info: (...values: unknown[]) => void;
  readonly warn: (...values: unknown[]) => void;
  readonly error: (...values: unknown[]) => void;
  readonly debug: (...values: unknown[]) => void;
  readonly dir: (...values: unknown[]) => void;
}

type DebugProgram = (bot: Bot, Vec3Constructor: typeof Vec3, console: CapturedConsole) => Promise<unknown>;
type AsyncFunctionConstructor = new (...argumentsAndBody: string[]) => DebugProgram;

// JavaScript does not publish AsyncFunction as a global constructor. This is
// the platform seam that obtains it while keeping the compiled program typed.
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as AsyncFunctionConstructor;

const INSPECT_OPTIONS = Object.freeze({
  colors: false,
  depth: 8,
  maxArrayLength: 200,
  maxStringLength: 16_384,
  breakLength: 120,
  compact: 3,
});

function bounded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `… [truncated ${text.length - limit} chars]`;
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function render(value: unknown): string {
  return bounded(inspect(value, INSPECT_OPTIONS), DEBUG_RENDERED_VALUE_MAX_CHARS);
}

function renderError(cause: unknown): string {
  const detail = cause instanceof Error ? cause.stack || cause.message : render(cause);
  return bounded(detail, DEBUG_RENDERED_VALUE_MAX_CHARS);
}

function captureConsole(): { readonly console: CapturedConsole; readonly lines: string[] } {
  const lines: string[] = [];
  let usedCharacters = 0;
  let truncated = false;

  const write = (level: string, values: unknown[]) => {
    if (truncated) return;
    const formatted = `[${level}] ${formatWithOptions(INSPECT_OPTIONS, ...values)}`;
    const remaining = DEBUG_LOG_MAX_CHARS - usedCharacters;
    if (lines.length >= DEBUG_LOG_MAX_LINES || remaining <= 0) {
      truncated = true;
      return;
    }
    const line = bounded(formatted, remaining);
    lines.push(line);
    usedCharacters += line.length;
    truncated = line.length < formatted.length;
  };

  return {
    lines,
    console: {
      log: (...values) => write("log", values),
      info: (...values) => write("info", values),
      warn: (...values) => write("warn", values),
      error: (...values) => write("error", values),
      debug: (...values) => write("debug", values),
      dir: (...values) => write("dir", values),
    },
  };
}

/** Compile and execute one unrestricted debug program against the live host bot. */
export async function executeDebugJavaScript(
  bot: Bot,
  request: DebugExecuteJavaScriptRequest,
): Promise<DebugExecuteJavaScriptResult> {
  const capture = captureConsole();
  try {
    const program = new AsyncFunction(
      "bot",
      "Vec3",
      "console",
      `"use strict";\n${request.code}\n//# sourceURL=debug_execute_javascript.mcp.js`,
    );
    const value = await program(bot, Vec3, capture.console);
    return {
      status: "succeeded",
      execution: { value: render(value), logs: capture.lines },
    };
  } catch (cause) {
    return {
      status: "failed",
      error: renderError(cause),
      execution: { value: "<program threw before returning>", logs: capture.lines },
    };
  }
}

export function formatDebugExecuteJavaScriptResult(result: DebugExecuteJavaScriptResult): string {
  const logs = result.execution.logs.length > 0 ? result.execution.logs.join("\n") : "(no console output)";
  const evidence = [
    "### Return value",
    markdownCodeBlock(result.execution.value),
    "### Console",
    markdownCodeBlock(logs),
  ].join("\n\n");
  return result.status === "succeeded" ? evidence : `**Observed stop:** ${result.error}\n\n${evidence}`;
}

/** Define the opt-in host-debug action. */
export function createDebugExecuteJavaScriptAction(bot: Bot) {
  return defineAction({
    checkpointSchema: executionCheckpointSchema,
    name: DEBUG_EXECUTE_JAVASCRIPT,
    description: DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION,
    inputSchema: debugExecuteJavaScriptInputSchema,
    resultSchema: debugExecuteJavaScriptResultSchema,
    formatResult: formatDebugExecuteJavaScriptResult,
    execution: { kind: "task" },
    annotations: debugExecuteJavaScriptAnnotations,
    parse: parseDebugExecuteJavaScriptRequest,
    execute: (request) => executeDebugJavaScript(bot, request),
  });
}
