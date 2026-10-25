/**
 * The published MCP tool surface, without a bot.
 *
 * `createActions` needs a connected Mineflayer bot, so nothing that only
 * wants to read the contract can call it. Every name, description, and schema
 * is owned by an action's `contract.ts` and is independent of runtime state,
 * so this reads the same `ACTION_CATALOG` rows the host builds from, without
 * calling their factories. Documentation and the docs site read it; the
 * running host still builds the real actions.
 */
import type { z } from "zod";
import {
  CANCEL_ACTION_DESCRIPTION,
  cancelActionInputSchema,
  submissionMetadataSchema,
  WAIT_FOR_ACTION_DESCRIPTION,
  waitForActionInputSchema,
} from "../session/async-actions.js";
import { ACTION_CATALOG } from "./catalog.js";

/** One published tool, as tool discovery describes it before MCP adds its metadata. */
export interface ActionToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  /** Present only when a host is started with debug actions explicitly enabled. */
  readonly debugOnly: boolean;
  readonly foreground: boolean;
}

/**
 * Every tool the catalog can publish, in the order `createActions` builds
 * them, then the two tools the async layer adds to control a submission.
 */
export function describeActionTools(): readonly ActionToolDescription[] {
  return Object.freeze([
    ...ACTION_CATALOG.map(({ name, description, inputSchema, foreground, debugOnly }) => ({
      name,
      description,
      // A foreground action is submitted asynchronously, so its published input carries the submission metadata.
      inputSchema: foreground ? inputSchema.safeExtend(submissionMetadataSchema.shape) : inputSchema,
      debugOnly,
      foreground,
    })),
    asyncTool("cancel_foreground_action", CANCEL_ACTION_DESCRIPTION, cancelActionInputSchema),
    asyncTool("wait_for_action", WAIT_FOR_ACTION_DESCRIPTION, waitForActionInputSchema),
  ]);
}

function asyncTool(name: string, description: string, inputSchema: z.ZodObject): ActionToolDescription {
  return { name, description, inputSchema, debugOnly: false, foreground: false };
}
