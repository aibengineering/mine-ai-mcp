import {
  ATTACK_DRAGON_PERCH,
  ATTACK_DRAGON_PERCH_DESCRIPTION,
  attackDragonPerchInputSchema,
} from "./attack-dragon-perch/contract.js";
import { SHOOT_DRAGON, SHOOT_DRAGON_DESCRIPTION, shootDragonInputSchema } from "./shoot-dragon/contract.js";
import {
  DESTROY_END_CRYSTAL,
  DESTROY_END_CRYSTAL_DESCRIPTION,
  destroyEndCrystalInputSchema,
} from "./destroy-end-crystal/contract.js";
import {
  SET_SURVIVAL_POLICY,
  SET_SURVIVAL_POLICY_DESCRIPTION,
  setSurvivalPolicyInputSchema,
} from "./set-survival-policy/contract.js";
/**
 * The published MCP tool surface, without a bot.
 *
 * `createActions` needs a connected Mineflayer bot, so nothing that only
 * wants to read the contract can call it. Every name, description, and schema
 * is owned by an action's `contract.ts` and is independent of runtime state, so
 * this list can be built from those modules alone. Documentation and the docs
 * site read it; the running host still builds the real actions.
 *
 * Adding an action to `createActions` without adding it here is a defect
 * that `mine-ai verify docs` fails on.
 */
import type { z } from "zod";
import { submissionMetadataSchema, waitForActionInputSchema, cancelActionInputSchema,
  WAIT_FOR_ACTION_DESCRIPTION, CANCEL_ACTION_DESCRIPTION } from "../session/async-actions.js";
import {
  ACTIVATE_PORTAL,
  ACTIVATE_PORTAL_DESCRIPTION,
  activatePortalInputSchema,
} from "./activate-portal/contract.js";
import { BARTER, BARTER_DESCRIPTION, barterInputSchema } from "./barter/contract.js";
import {
  BUILD_STRUCTURE,
  BUILD_STRUCTURE_DESCRIPTION,
  buildStructureInputSchema,
} from "./build-structure/contract.js";
import {
  CANCEL_FOREGROUND_ACTION,
} from "./cancel-foreground-action/contract.js";
import {
  COLLECT_BLOCK,
  COLLECT_BLOCK_DESCRIPTION,
  collectBlockInputSchema,
} from "./collect-block/contract.js";
import { CRAFT_ITEM, CRAFT_ITEM_DESCRIPTION, craftItemInputSchema } from "./craft-item/contract.js";
import {
  DEBUG_EXECUTE_JAVASCRIPT,
  DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION,
  debugExecuteJavaScriptInputSchema,
} from "./debug-execute-javascript/contract.js";
import {
  DEBUG_SET_PATHFINDER_TELEMETRY,
  DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION,
  debugSetPathfinderTelemetryInputSchema,
} from "./debug-set-pathfinder-telemetry/contract.js";
import { DROP_ITEM, DROP_ITEM_DESCRIPTION, dropItemInputSchema } from "./drop-item/contract.js";
import { EAT_FOOD, EAT_FOOD_DESCRIPTION, eatFoodInputSchema } from "./eat-food/contract.js";
import { EQUIP, EQUIP_DESCRIPTION, equipInputSchema } from "./equip/contract.js";
import {
  EXPLORE_FRONTIER,
  EXPLORE_FRONTIER_DESCRIPTION,
  exploreFrontierInputSchema,
} from "./explore-frontier/contract.js";
import {
  COLLECT_MOB_DROP,
  COLLECT_MOB_DROP_DESCRIPTION,
  huntMobInputSchema,
} from "./hunt-mob/contract.js";
import {
  LOCATE_STRONGHOLD,
  LOCATE_STRONGHOLD_DESCRIPTION,
  locateStrongholdInputSchema,
} from "./locate-stronghold/contract.js";
import { NAVIGATE, NAVIGATE_DESCRIPTION, navigateInputSchema } from "./navigate/contract.js";
import { ENTER_END_PORTAL, ENTER_END_PORTAL_DESCRIPTION, ENTER_NETHER_PORTAL, ENTER_NETHER_PORTAL_DESCRIPTION, enterEndPortalInputSchema, enterNetherPortalInputSchema } from "./portal-entry/contract.js";
import {
  PLACE_BLOCK,
  PLACE_BLOCK_DESCRIPTION,
  placeBlockInputSchema,
} from "./place-block/contract.js";
import {
  PREPARE_DRAGON_PERCH,
  PREPARE_DRAGON_PERCH_DESCRIPTION,
  prepareDragonPerchInputSchema,
} from "./prepare-dragon-perch/contract.js";
import { PICK_UP_ITEMS, PICK_UP_ITEMS_DESCRIPTION, pickUpItemsInputSchema } from "./pick-up-items/contract.js";
import {
  QUERY_BOT_DATA,
  QUERY_BOT_DATA_DESCRIPTION,
  queryBotDataInputSchema,
} from "./query-bot-data/contract.js";
import { RAW_ACTION, RAW_ACTION_DESCRIPTION, rawActionInputSchema } from "./raw-action/contract.js";
import {
  READ_RECENT_EVENTS,
  READ_RECENT_EVENTS_DESCRIPTION,
  readRecentEventsInputSchema,
} from "./read-recent-events/contract.js";
import {
  SEND_MESSAGE,
  SEND_MESSAGE_DESCRIPTION,
  sendMessageInputSchema,
} from "./send-message/contract.js";
import { SLEEP, SLEEP_DESCRIPTION, sleepInputSchema } from "./sleep/contract.js";
import { SMELT_ITEM, SMELT_ITEM_DESCRIPTION, smeltItemInputSchema } from "./smelt-item/contract.js";
import { USE_BUCKET, USE_BUCKET_DESCRIPTION, useBucketInputSchema } from "./use-bucket/contract.js";
import {
  USE_CONTAINER,
  USE_CONTAINER_DESCRIPTION,
  useContainerInputSchema,
} from "./use-container/contract.js";
import {
  VIEW_BLOCKS,
  VIEW_BLOCKS_DESCRIPTION,
  viewBlocksInputSchema,
} from "./view-blocks/contract.js";
import {
  VIEW_CRAFTING_REQUIREMENTS,
  VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION,
  viewCraftingRequirementsInputSchema,
} from "./view-crafting-requirements/contract.js";
import {
  VIEW_FRONTIER,
  VIEW_FRONTIER_DESCRIPTION,
  viewFrontierInputSchema,
} from "./view-frontier/contract.js";
import { VIEW_STATUS, VIEW_STATUS_DESCRIPTION, viewStatusInputSchema } from "./view-status/contract.js";

import { NOTE_READ, NOTE_READ_DESCRIPTION, noteReadInputSchema } from "./note-read/contract.js";
import { NOTE_SAVE, NOTE_SAVE_DESCRIPTION, noteSaveInputSchema } from "./note-save/contract.js";

/** One published tool, as tool discovery describes it before MCP adds its metadata. */
export interface ActionToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  /** Present only when a host is started with debug actions explicitly enabled. */
  readonly debugOnly: boolean;
  readonly foreground: boolean;
}

/** Every tool the catalog can publish, in the order `createActions` builds them. */
export function describeActionTools(): readonly ActionToolDescription[] {
  return Object.freeze([
    tool(DESTROY_END_CRYSTAL, DESTROY_END_CRYSTAL_DESCRIPTION, destroyEndCrystalInputSchema),
    tool(ATTACK_DRAGON_PERCH, ATTACK_DRAGON_PERCH_DESCRIPTION, attackDragonPerchInputSchema),
    tool(BARTER, BARTER_DESCRIPTION, barterInputSchema),
    tool(
      CANCEL_FOREGROUND_ACTION,
      CANCEL_ACTION_DESCRIPTION,
      cancelActionInputSchema,
      { foreground: false },
    ),
    tool("wait_for_action", WAIT_FOR_ACTION_DESCRIPTION, waitForActionInputSchema, { foreground: false }),
    tool(BUILD_STRUCTURE, BUILD_STRUCTURE_DESCRIPTION, buildStructureInputSchema),
    tool(COLLECT_BLOCK, COLLECT_BLOCK_DESCRIPTION, collectBlockInputSchema),
    tool(CRAFT_ITEM, CRAFT_ITEM_DESCRIPTION, craftItemInputSchema),
    tool(SET_SURVIVAL_POLICY, SET_SURVIVAL_POLICY_DESCRIPTION, setSurvivalPolicyInputSchema, { foreground: false }),
    tool(EAT_FOOD, EAT_FOOD_DESCRIPTION, eatFoodInputSchema),
    tool(DROP_ITEM, DROP_ITEM_DESCRIPTION, dropItemInputSchema),
    tool(EQUIP, EQUIP_DESCRIPTION, equipInputSchema),
    tool(EXPLORE_FRONTIER, EXPLORE_FRONTIER_DESCRIPTION, exploreFrontierInputSchema),
    tool(COLLECT_MOB_DROP, COLLECT_MOB_DROP_DESCRIPTION, huntMobInputSchema),
    tool(ACTIVATE_PORTAL, ACTIVATE_PORTAL_DESCRIPTION, activatePortalInputSchema),
    tool(LOCATE_STRONGHOLD, LOCATE_STRONGHOLD_DESCRIPTION, locateStrongholdInputSchema),
    tool(ENTER_NETHER_PORTAL, ENTER_NETHER_PORTAL_DESCRIPTION, enterNetherPortalInputSchema),
    tool(ENTER_END_PORTAL, ENTER_END_PORTAL_DESCRIPTION, enterEndPortalInputSchema),
    tool(NAVIGATE, NAVIGATE_DESCRIPTION, navigateInputSchema),
    tool(NOTE_SAVE, NOTE_SAVE_DESCRIPTION, noteSaveInputSchema),
    tool(NOTE_READ, NOTE_READ_DESCRIPTION, noteReadInputSchema, { foreground: false }),
    tool(PLACE_BLOCK, PLACE_BLOCK_DESCRIPTION, placeBlockInputSchema),
    tool(PREPARE_DRAGON_PERCH, PREPARE_DRAGON_PERCH_DESCRIPTION, prepareDragonPerchInputSchema),
    tool(SHOOT_DRAGON, SHOOT_DRAGON_DESCRIPTION, shootDragonInputSchema),
    tool(PICK_UP_ITEMS, PICK_UP_ITEMS_DESCRIPTION, pickUpItemsInputSchema),
    tool(RAW_ACTION, RAW_ACTION_DESCRIPTION, rawActionInputSchema),
    tool(QUERY_BOT_DATA, QUERY_BOT_DATA_DESCRIPTION, queryBotDataInputSchema, { foreground: false }),
    tool(READ_RECENT_EVENTS, READ_RECENT_EVENTS_DESCRIPTION, readRecentEventsInputSchema, { foreground: false }),
    tool(SEND_MESSAGE, SEND_MESSAGE_DESCRIPTION, sendMessageInputSchema),
    tool(SLEEP, SLEEP_DESCRIPTION, sleepInputSchema),
    tool(SMELT_ITEM, SMELT_ITEM_DESCRIPTION, smeltItemInputSchema),
    tool(USE_BUCKET, USE_BUCKET_DESCRIPTION, useBucketInputSchema),
    tool(USE_CONTAINER, USE_CONTAINER_DESCRIPTION, useContainerInputSchema),
    tool(
      VIEW_CRAFTING_REQUIREMENTS,
      VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION,
      viewCraftingRequirementsInputSchema,
      { foreground: false },
    ),
    tool(VIEW_FRONTIER, VIEW_FRONTIER_DESCRIPTION, viewFrontierInputSchema, { foreground: false }),
    tool(VIEW_BLOCKS, VIEW_BLOCKS_DESCRIPTION, viewBlocksInputSchema, { foreground: false }),
    tool(VIEW_STATUS, VIEW_STATUS_DESCRIPTION, viewStatusInputSchema, { foreground: false }),
    tool(
      DEBUG_SET_PATHFINDER_TELEMETRY,
      DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION,
      debugSetPathfinderTelemetryInputSchema,
      { debugOnly: true, foreground: false },
    ),
    tool(DEBUG_EXECUTE_JAVASCRIPT, DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION, debugExecuteJavaScriptInputSchema, { debugOnly: true }),
  ]);
}

function tool(
  name: string,
  description: string,
  inputSchema: z.ZodObject,
  { debugOnly = false, foreground = true }: { debugOnly?: boolean; foreground?: boolean } = {},
): ActionToolDescription {
  return { name, description, inputSchema: foreground ? inputSchema.safeExtend(submissionMetadataSchema.shape) : inputSchema, debugOnly, foreground };
}
