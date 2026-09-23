/**
 * The boundary between shared test infrastructure and replaceable test logic.
 * Drivers receive scenario data and recorded action calls so they can express
 * a test without managing the bot, runtime, cancellation or recording themselves.
 */
import type { ClientCompletion, ScenarioDefinition } from "mine-labs/client";
import type { ActionOutput, ActionResult } from "@aibengineering/mine-ai-mcp";

/** Action evidence, independent of the test's expectation. */
export interface ScenarioCall extends ActionOutput<string, ActionResult> {
  readonly summary: string;
}

export interface ScenarioContext {
  readonly scenario: ScenarioDefinition;
  /** Run a registered action; the host owns cancellation, recording and cleanup. */
  call(action: string, input: Record<string, unknown>): Promise<ScenarioCall>;
}

export type ScenarioRun = (context: ScenarioContext) => Promise<ClientCompletion>;
