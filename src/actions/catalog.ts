/**
 * Every model-runnable action this host offers, in one list.
 *
 * Each row pairs what discovery publishes (name, description, input schema,
 * whether it owns the foreground) with the factory the running host calls.
 * `createActions` builds the rows and `describeActionTools` reads them without
 * a bot, so a tool cannot be offered by one and missing from the other.
 *
 * This is deliberately a list and not a framework. An action owns its own MCP
 * tool schema, argument parsing, dependencies, and execution. Factories close
 * over only what they need so the generic action context stays a cancellation
 * signal rather than becoming a service bag.
 */
import type { Bot } from "mineflayer";
import type { z } from "zod";
import { snapshotBotStatus, updateBotStatus, type SqlBotData } from "../bot-data/index.js";
import type { NavigationRuntime } from "../navigation/index.js";
import type { SessionFrontier } from "../bot-data/frontier.js";
import type { CombatController } from "../survival/index.js";
import type { Budgets } from "../survival/state/budgets.js";
import type { DiscardedItems } from "../world/watchers/discarded-items.js";
import type { Action } from "./action.js";
import { ACTIVATE_PORTAL, ACTIVATE_PORTAL_DESCRIPTION, activatePortalInputSchema } from "./activate-portal/contract.js";
import { createActivatePortalAction } from "./activate-portal/index.js";
import { ATTACK_DRAGON_PERCH, ATTACK_DRAGON_PERCH_DESCRIPTION, attackDragonPerchInputSchema } from "./attack-dragon-perch/contract.js";
import { createAttackDragonPerchAction } from "./attack-dragon-perch/index.js";
import { BARTER, BARTER_DESCRIPTION, barterInputSchema } from "./barter/contract.js";
import { createBarterAction } from "./barter/index.js";
import { BUILD_STRUCTURE, BUILD_STRUCTURE_DESCRIPTION, buildStructureInputSchema } from "./build-structure/contract.js";
import { createBuildStructureAction } from "./build-structure/index.js";
import { COLLECT_BLOCK, COLLECT_BLOCK_DESCRIPTION, collectBlockInputSchema } from "./collect-block/contract.js";
import { createCollectBlockAction } from "./collect-block/index.js";
import { CRAFT_ITEM, CRAFT_ITEM_DESCRIPTION, craftItemInputSchema } from "./craft-item/contract.js";
import { createCraftItemAction } from "./craft-item/index.js";
import {
  DEBUG_EXECUTE_JAVASCRIPT,
  DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION,
  debugExecuteJavaScriptInputSchema,
} from "./debug-execute-javascript/contract.js";
import { createDebugExecuteJavaScriptAction } from "./debug-execute-javascript/index.js";
import {
  DEBUG_SET_PATHFINDER_TELEMETRY,
  DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION,
  debugSetPathfinderTelemetryInputSchema,
} from "./debug-set-pathfinder-telemetry/contract.js";
import { createDebugSetPathfinderTelemetryAction } from "./debug-set-pathfinder-telemetry/index.js";
import { DESTROY_END_CRYSTAL, DESTROY_END_CRYSTAL_DESCRIPTION, destroyEndCrystalInputSchema } from "./destroy-end-crystal/contract.js";
import { createDestroyEndCrystalAction } from "./destroy-end-crystal/index.js";
import { DROP_ITEM, DROP_ITEM_DESCRIPTION, dropItemInputSchema } from "./drop-item/contract.js";
import { createDropItemAction } from "./drop-item/index.js";
import { EAT_FOOD, EAT_FOOD_DESCRIPTION, eatFoodInputSchema } from "./eat-food/contract.js";
import { createEatFoodAction } from "./eat-food/index.js";
import { EQUIP, EQUIP_DESCRIPTION, equipInputSchema } from "./equip/contract.js";
import { createEquipAction } from "./equip/index.js";
import { EXPLORE_FRONTIER, EXPLORE_FRONTIER_DESCRIPTION, exploreFrontierInputSchema } from "./explore-frontier/contract.js";
import { createExploreFrontierAction } from "./explore-frontier/index.js";
import { COLLECT_MOB_DROP, COLLECT_MOB_DROP_DESCRIPTION, huntMobInputSchema } from "./hunt-mob/contract.js";
import { createCollectMobDropAction } from "./hunt-mob/index.js";
import { LOCATE_STRONGHOLD, LOCATE_STRONGHOLD_DESCRIPTION, locateStrongholdInputSchema } from "./locate-stronghold/contract.js";
import { createLocateStrongholdAction, type StrongholdEyeFlights } from "./locate-stronghold/index.js";
import { NAVIGATE, NAVIGATE_DESCRIPTION, navigateInputSchema } from "./navigate/contract.js";
import { createNavigateAction } from "./navigate/index.js";
import { NOTE_READ, NOTE_READ_DESCRIPTION, noteReadInputSchema } from "./note-read/contract.js";
import { createNoteReadAction } from "./note-read/index.js";
import { NOTE_SAVE, NOTE_SAVE_DESCRIPTION, noteSaveInputSchema } from "./note-save/contract.js";
import { createNoteSaveAction } from "./note-save/index.js";
import { PICK_UP_ITEMS, PICK_UP_ITEMS_DESCRIPTION, pickUpItemsInputSchema } from "./pick-up-items/contract.js";
import { createPickUpItemsAction } from "./pick-up-items/index.js";
import { PLACE_BLOCK, PLACE_BLOCK_DESCRIPTION, placeBlockInputSchema } from "./place-block/contract.js";
import { createPlaceBlockAction } from "./place-block/index.js";
import {
  ENTER_END_PORTAL,
  ENTER_END_PORTAL_DESCRIPTION,
  ENTER_NETHER_PORTAL,
  ENTER_NETHER_PORTAL_DESCRIPTION,
  enterEndPortalInputSchema,
  enterNetherPortalInputSchema,
} from "./portal-entry/contract.js";
import { createEnterEndPortalAction, createEnterNetherPortalAction } from "./portal-entry/index.js";
import { PREPARE_DRAGON_PERCH, PREPARE_DRAGON_PERCH_DESCRIPTION, prepareDragonPerchInputSchema } from "./prepare-dragon-perch/contract.js";
import { createPrepareDragonPerchAction } from "./prepare-dragon-perch/index.js";
import { QUERY_BOT_DATA, QUERY_BOT_DATA_DESCRIPTION, queryBotDataInputSchema } from "./query-bot-data/contract.js";
import { createQueryBotDataAction } from "./query-bot-data/index.js";
import { RAW_ACTION, RAW_ACTION_DESCRIPTION, rawActionInputSchema } from "./raw-action/contract.js";
import { createRawAction } from "./raw-action/index.js";
import { READ_RECENT_EVENTS, READ_RECENT_EVENTS_DESCRIPTION, readRecentEventsInputSchema } from "./read-recent-events/contract.js";
import { createReadRecentEventsAction } from "./read-recent-events/index.js";
import { SEND_MESSAGE, SEND_MESSAGE_DESCRIPTION, sendMessageInputSchema } from "./send-message/contract.js";
import { createSendMessageAction } from "./send-message/index.js";
import { SET_SURVIVAL_POLICY, SET_SURVIVAL_POLICY_DESCRIPTION, setSurvivalPolicyInputSchema } from "./set-survival-policy/contract.js";
import { createSetSurvivalPolicyAction } from "./set-survival-policy/index.js";
import { SHOOT_DRAGON, SHOOT_DRAGON_DESCRIPTION, shootDragonInputSchema } from "./shoot-dragon/contract.js";
import { createShootDragonAction } from "./shoot-dragon/index.js";
import { SLEEP, SLEEP_DESCRIPTION, sleepInputSchema } from "./sleep/contract.js";
import { createSleepAction } from "./sleep/index.js";
import { SMELT_ITEM, SMELT_ITEM_DESCRIPTION, smeltItemInputSchema } from "./smelt-item/contract.js";
import { createSmeltItemAction } from "./smelt-item/index.js";
import { USE_BUCKET, USE_BUCKET_DESCRIPTION, useBucketInputSchema } from "./use-bucket/contract.js";
import { createUseBucketAction } from "./use-bucket/index.js";
import { USE_CONTAINER, USE_CONTAINER_DESCRIPTION, useContainerInputSchema } from "./use-container/contract.js";
import { createUseContainerAction } from "./use-container/index.js";
import { VIEW_BLOCKS, VIEW_BLOCKS_DESCRIPTION, viewBlocksInputSchema } from "./view-blocks/contract.js";
import { createViewBlocksAction } from "./view-blocks/index.js";
import {
  VIEW_CRAFTING_REQUIREMENTS,
  VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION,
  viewCraftingRequirementsInputSchema,
} from "./view-crafting-requirements/contract.js";
import { createViewCraftingRequirementsAction } from "./view-crafting-requirements/index.js";
import { VIEW_FRONTIER, VIEW_FRONTIER_DESCRIPTION, viewFrontierInputSchema } from "./view-frontier/contract.js";
import { createViewFrontierAction } from "./view-frontier/index.js";
import { VIEW_STATUS, VIEW_STATUS_DESCRIPTION, viewStatusInputSchema } from "./view-status/contract.js";
import { createViewStatusAction, type ObserveStatusActivity } from "./view-status/index.js";

export interface ActionDependencies {
  readonly budgets: Budgets;
  readonly bot: Bot;
  readonly botData: SqlBotData;
  readonly frontier: SessionFrontier;
  readonly navigation: NavigationRuntime;
  readonly strongholdEyeFlights: StrongholdEyeFlights;
  /** The one combat controller; the hunt fights through it and the hostile reflex reads its state. */
  readonly combat: CombatController;
  readonly observeStatusActivity: ObserveStatusActivity;
}

/** What one `createActions` call shares between its factories, beside the host's dependencies. */
export interface CatalogDependencies extends ActionDependencies {
  /** The dropper records what it threw away and the hunt's sweep reads the same set. */
  readonly discarded: DiscardedItems;
}

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  /** Whether the action owns the foreground slot, and so accepts the async submission inputs. */
  readonly foreground: boolean;
  /** Present only when a host is started with debug actions explicitly enabled. */
  readonly debugOnly: boolean;
  readonly create: (dependencies: CatalogDependencies) => Action;
}

function entry(
  name: string,
  description: string,
  inputSchema: z.ZodObject,
  create: CatalogEntry["create"],
  { foreground = true, debugOnly = false }: { foreground?: boolean; debugOnly?: boolean } = {},
): CatalogEntry {
  return { name, description, inputSchema, foreground, debugOnly, create };
}

const observer = { foreground: false } as const;

/** Every action, in the order the host builds and lists them. */
export const ACTION_CATALOG: readonly CatalogEntry[] = Object.freeze([
  entry(SET_SURVIVAL_POLICY, SET_SURVIVAL_POLICY_DESCRIPTION, setSurvivalPolicyInputSchema,
    (d) => createSetSurvivalPolicyAction(d.combat.policy), observer),
  entry(DESTROY_END_CRYSTAL, DESTROY_END_CRYSTAL_DESCRIPTION, destroyEndCrystalInputSchema,
    (d) => createDestroyEndCrystalAction(d.bot, d.combat)),
  entry(ATTACK_DRAGON_PERCH, ATTACK_DRAGON_PERCH_DESCRIPTION, attackDragonPerchInputSchema,
    (d) => createAttackDragonPerchAction(d.bot, d.combat)),
  entry(SHOOT_DRAGON, SHOOT_DRAGON_DESCRIPTION, shootDragonInputSchema, (d) => createShootDragonAction(d.bot, d.combat)),
  entry(BUILD_STRUCTURE, BUILD_STRUCTURE_DESCRIPTION, buildStructureInputSchema,
    (d) => createBuildStructureAction(d.bot, d.navigation)),
  entry(COLLECT_BLOCK, COLLECT_BLOCK_DESCRIPTION, collectBlockInputSchema,
    (d) => createCollectBlockAction(d.bot, d.navigation, d.discarded)),
  entry(CRAFT_ITEM, CRAFT_ITEM_DESCRIPTION, craftItemInputSchema, (d) => createCraftItemAction(d.bot, d.navigation)),
  entry(DROP_ITEM, DROP_ITEM_DESCRIPTION, dropItemInputSchema,
    (d) => createDropItemAction(d.bot, d.navigation, d.discarded)),
  entry(BARTER, BARTER_DESCRIPTION, barterInputSchema, (d) => createBarterAction(d.bot, d.navigation)),
  entry(EAT_FOOD, EAT_FOOD_DESCRIPTION, eatFoodInputSchema, (d) => createEatFoodAction(d.bot)),
  entry(EQUIP, EQUIP_DESCRIPTION, equipInputSchema, (d) => createEquipAction(d.bot)),
  entry(EXPLORE_FRONTIER, EXPLORE_FRONTIER_DESCRIPTION, exploreFrontierInputSchema,
    (d) => createExploreFrontierAction(d.bot, d.navigation, d.frontier, d.botData)),
  entry(COLLECT_MOB_DROP, COLLECT_MOB_DROP_DESCRIPTION, huntMobInputSchema,
    (d) => createCollectMobDropAction(d.bot, d.navigation, d.combat, d.discarded, undefined, d.budgets)),
  entry(ACTIVATE_PORTAL, ACTIVATE_PORTAL_DESCRIPTION, activatePortalInputSchema,
    (d) => createActivatePortalAction(d.bot, d.navigation)),
  entry(LOCATE_STRONGHOLD, LOCATE_STRONGHOLD_DESCRIPTION, locateStrongholdInputSchema,
    (d) => createLocateStrongholdAction(d.bot, d.navigation, d.botData, d.strongholdEyeFlights)),
  entry(ENTER_NETHER_PORTAL, ENTER_NETHER_PORTAL_DESCRIPTION, enterNetherPortalInputSchema,
    (d) => createEnterNetherPortalAction(d.bot, d.navigation)),
  entry(ENTER_END_PORTAL, ENTER_END_PORTAL_DESCRIPTION, enterEndPortalInputSchema,
    (d) => createEnterEndPortalAction(d.bot, d.navigation)),
  entry(NAVIGATE, NAVIGATE_DESCRIPTION, navigateInputSchema, (d) => createNavigateAction(d.bot, d.navigation)),
  entry(NOTE_SAVE, NOTE_SAVE_DESCRIPTION, noteSaveInputSchema, (d) => createNoteSaveAction(d.bot, d.botData)),
  entry(NOTE_READ, NOTE_READ_DESCRIPTION, noteReadInputSchema,
    (d) => createNoteReadAction(d.botData, d.bot.username), observer),
  entry(PLACE_BLOCK, PLACE_BLOCK_DESCRIPTION, placeBlockInputSchema, (d) => createPlaceBlockAction(d.bot, d.navigation)),
  entry(PREPARE_DRAGON_PERCH, PREPARE_DRAGON_PERCH_DESCRIPTION, prepareDragonPerchInputSchema,
    (d) => createPrepareDragonPerchAction(d.bot, d.combat)),
  entry(PICK_UP_ITEMS, PICK_UP_ITEMS_DESCRIPTION, pickUpItemsInputSchema,
    (d) => createPickUpItemsAction(d.bot, d.navigation, d.botData, d.discarded)),
  entry(RAW_ACTION, RAW_ACTION_DESCRIPTION, rawActionInputSchema, (d) => createRawAction(d.bot)),
  entry(QUERY_BOT_DATA, QUERY_BOT_DATA_DESCRIPTION, queryBotDataInputSchema,
    (d) => createQueryBotDataAction(d.botData, () => updateBotStatus(d.botData, snapshotBotStatus(d.bot))), observer),
  entry(READ_RECENT_EVENTS, READ_RECENT_EVENTS_DESCRIPTION, readRecentEventsInputSchema,
    (d) => createReadRecentEventsAction(d.botData, d.bot.username), observer),
  entry(SEND_MESSAGE, SEND_MESSAGE_DESCRIPTION, sendMessageInputSchema, (d) => createSendMessageAction(d.bot)),
  entry(SLEEP, SLEEP_DESCRIPTION, sleepInputSchema, (d) => createSleepAction(d.bot, d.navigation)),
  entry(SMELT_ITEM, SMELT_ITEM_DESCRIPTION, smeltItemInputSchema, (d) => createSmeltItemAction(d.bot, d.navigation)),
  entry(USE_BUCKET, USE_BUCKET_DESCRIPTION, useBucketInputSchema, (d) => createUseBucketAction(d.bot, d.navigation)),
  entry(USE_CONTAINER, USE_CONTAINER_DESCRIPTION, useContainerInputSchema,
    (d) => createUseContainerAction(d.bot, d.navigation, d.botData)),
  entry(VIEW_BLOCKS, VIEW_BLOCKS_DESCRIPTION, viewBlocksInputSchema, (d) => createViewBlocksAction(d.bot), observer),
  entry(VIEW_CRAFTING_REQUIREMENTS, VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION, viewCraftingRequirementsInputSchema,
    (d) => createViewCraftingRequirementsAction(d.bot), observer),
  entry(VIEW_FRONTIER, VIEW_FRONTIER_DESCRIPTION, viewFrontierInputSchema,
    (d) => createViewFrontierAction(d.botData, () => snapshotBotStatus(d.bot)), observer),
  entry(VIEW_STATUS, VIEW_STATUS_DESCRIPTION, viewStatusInputSchema,
    (d) => createViewStatusAction(d.bot, d.botData, d.observeStatusActivity), observer),
  entry(DEBUG_SET_PATHFINDER_TELEMETRY, DEBUG_SET_PATHFINDER_TELEMETRY_DESCRIPTION, debugSetPathfinderTelemetryInputSchema,
    (d) => createDebugSetPathfinderTelemetryAction(d.navigation), { foreground: false, debugOnly: true }),
  entry(DEBUG_EXECUTE_JAVASCRIPT, DEBUG_EXECUTE_JAVASCRIPT_DESCRIPTION, debugExecuteJavaScriptInputSchema,
    (d) => createDebugExecuteJavaScriptAction(d.bot), { debugOnly: true }),
]);
