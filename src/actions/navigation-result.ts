/**
 * How an action tells the model what a route did.
 *
 * Navigation returns typed evidence; the wording is the action's. Sleep,
 * Smelt, and Use Container all report a stopped approach the same way, so the
 * one sentence they share lives here rather than being three copies or a
 * formatter inside navigation.
 */
import type { NavigationResult } from "../navigation/index.js";

export function describeNavigation(result: NavigationResult): string {
  return result.status === "completed"
    ? `completed after ${result.elapsedMs} ms`
    : `stopped after ${result.elapsedMs} ms: ${result.reason}`;
}
