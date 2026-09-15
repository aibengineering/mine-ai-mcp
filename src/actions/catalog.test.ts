import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createActions, type ActionCatalogOptions } from "./index.js";
import { describeActionTools } from "./describe.js";

/**
 * The published contract of every action, as the MCP client sees it: its name,
 * how it runs, and whether a caller may treat it as read-only or destructive.
 * One table, so a new action is listed here deliberately and an annotation
 * cannot drift on one action without the whole catalogue saying so.
 */
const PUBLISHED: ReadonlyArray<
  readonly [name: string, execution: string, readOnly: boolean, destructive: boolean | null]
> = [
  ["set_survival_policy", "control", false, null],
  ["destroy_end_crystal", "resumable_task", false, true],
  ["attack_dragon_perch", "resumable_task", false, true],
  ["shoot_dragon", "resumable_task", false, true],
  ["build_structure", "task", false, true],
  ["cancel_foreground_action", "control", false, true],
  ["collect_block", "resumable_task", false, true],
  ["craft_item", "task", false, true],
  ["drop_item", "task", false, true],
  ["barter", "resumable_task", false, true],
  ["eat_food", "task", false, true],
  ["equip", "task", false, false],
  ["explore_frontier", "resumable_task", false, false],
  ["collect_mob_drop", "resumable_task", false, true],
  ["activate_portal", "resumable_task", false, true],
  ["locate_stronghold", "resumable_task", false, true],
  ["enter_nether_portal", "resumable_task", false, true],
  ["enter_end_portal", "resumable_task", false, true],
  ["navigate", "resumable_task", false, true],
  ["note_save", "task", false, false],
  ["note_read", "information", true, false],
  ["place_block", "task", false, true],
  ["prepare_dragon_perch", "resumable_task", false, true],
  ["pick_up_items", "resumable_task", false, false],
  ["raw_action", "task", false, true],
  ["query_bot_data", "information", true, null],
  ["read_recent_events", "information", true, false],
  ["send_message", "task", false, false],
  ["sleep", "task", false, null],
  ["smelt_item", "task", false, true],
  ["use_bucket", "task", false, true],
  ["use_container", "task", false, true],
  ["view_blocks", "information", true, null],
  ["view_crafting_requirements", "information", true, false],
  ["view_frontier", "information", true, null],
  ["view_status", "information", true, null],
];

const DEBUG_ONLY = [
  ["debug_set_pathfinder_telemetry", "control", false, false],
  ["debug_execute_javascript", "task", false, true],
] as const;

function published(t: { after(fn: () => void): void }, options: ActionCatalogOptions = {}) {
  // Every factory only stores what it is given; nothing here is exercised.
  return createActions(
    {
      bot: botFixture(),
      botData: temporaryBotData({ closeAfter: t }),
      budgets: {} as never,
      frontier: {} as never,
      navigation: {} as never,
      strongholdEyeFlights: {} as never,
      combat: { policy: { declareQuarry() {}, reserveArrows() {} } } as never,
      cancelForegroundAction: () => ({}) as never,
      observeStatusActivity: () => ({}) as never,
    },
    options,
  ).map((action) => {
    if (action.execution.kind === "task" || action.execution.kind === "resumable_task") {
      assert.ok(action.checkpointSchema, `${action.name} must declare its typed progress checkpoint`);
    }
    return [
    action.name,
    action.execution.kind,
    action.annotations?.readOnlyHint ?? false,
    action.annotations?.destructiveHint ?? null,
    ];
  });
}

test("every action publishes its name, execution, and read-only and destructive hints", (t) => {
  assert.deepEqual(published(t), PUBLISHED);
  assert.deepEqual(published(t, { debugExecuteJavaScript: true }), [...PUBLISHED, ...DEBUG_ONLY]);
});

test("discovery agrees with execution ownership and publishes the async inputs", () => {
  const descriptions = describeActionTools();
  const expected = [...PUBLISHED, ...DEBUG_ONLY];
  assert.deepEqual(descriptions.map((tool) => tool.name).sort(), [...expected.map(([name]) => name), "wait_for_action"].sort());
  for (const [name, execution] of expected) {
    const tool = descriptions.find((item) => item.name === name)!;
    const foreground = execution === "task" || execution === "resumable_task";
    assert.equal(tool.foreground, foreground, name);
    assert.equal("submission_id" in tool.inputSchema.shape, foreground, name);
    assert.equal("wait_timeout_ms" in tool.inputSchema.shape, foreground, name);
    assert.equal("acknowledge_result" in tool.inputSchema.shape, false, name);
  }
  for (const name of ["wait_for_action", "cancel_foreground_action"]) {
    assert.ok("action_id" in descriptions.find((tool) => tool.name === name)!.inputSchema.shape);
  }
});
