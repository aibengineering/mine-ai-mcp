/**
 * Every model-runnable action this host offers, built once with its dependencies.
 * The list itself, shared with tool discovery, is `ACTION_CATALOG` in catalog.ts.
 */
import { createDiscardedItems } from "../world/discarded-items.js";
import type { Action } from "./action.js";
import { ACTION_CATALOG, type ActionDependencies } from "./catalog.js";

export type { ActionDependencies } from "./catalog.js";

export interface ActionCatalogOptions {
  readonly debugExecuteJavaScript?: boolean;
}

export function createActions(dependencies: ActionDependencies, options: ActionCatalogOptions = {}) {
  // One registry, shared: the dropper records what it threw away and the hunt's
  // sweep reads the same set, so a deliberate discard is not picked back up.
  const shared = { ...dependencies, discarded: createDiscardedItems() };
  const actions: Action[] = ACTION_CATALOG.filter((entry) => !entry.debugOnly || options.debugExecuteJavaScript).map(
    (entry) => entry.create(shared),
  );
  return Object.freeze(actions);
}

export * from "./action.js";
export * from "./activate-portal/index.js";
export * from "./attack-dragon-perch/index.js";
export * from "./shoot-dragon/index.js";
export * from "./barter/index.js";
export * from "./build-structure/index.js";
export * from "./collect-block/index.js";
export * from "./craft-item/index.js";
export * from "./debug-execute-javascript/index.js";
export * from "./debug-set-pathfinder-telemetry/index.js";
export * from "./describe.js";
export * from "./destroy-end-crystal/index.js";
export * from "./drop-item/index.js";
export * from "./eat-food/index.js";
export * from "./explore-frontier/index.js";
export * from "./hunt-mob/index.js";
export * from "./locate-stronghold/index.js";
export * from "./markdown.js";
export * from "./navigate/index.js";
export * from "./note-read/index.js";
export * from "./note-save/index.js";
export * from "./place-block/index.js";
export * from "./prepare-dragon-perch/index.js";
export * from "./pick-up-items/index.js";
export * from "./portal-entry/index.js";
export * from "./query-bot-data/index.js";
export * from "./raw-action/index.js";
export * from "./read-recent-events/index.js";
export * from "./send-message/index.js";
export * from "./sleep/index.js";
export * from "./smelt-item/index.js";
export * from "./sql-action.js";
export * from "./use-bucket/index.js";
export * from "./use-container/index.js";
export * from "./view-blocks/index.js";
export * from "./view-crafting-requirements/index.js";
export * from "./view-frontier/index.js";
export * from "./view-status/index.js";
