import assert from "node:assert/strict";
import { debugExecuteJavaScriptResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioRun } from "../scenario.ts";

/** One straight leg east: its steady speed, and whether the shield was up throughout. */
interface Leg {
  readonly label: string;
  readonly shieldRaised: boolean;
  readonly blocksPerSecond: number;
  readonly serverCorrections: number;
}

// Each leg settles, faces east, raises the shield when asked, reaches its
// steady speed over ten ticks, then measures forty: two seconds of travel.
const MEASURE_LEGS = String.raw`
const ticks = (n) => bot.waitForTicks(n);
let corrections = 0;
const corrected = () => { corrections += 1; };
bot.on("forcedMove", corrected);
async function leg(label, shield, sprint) {
  bot.clearControlStates();
  await ticks(10);
  await bot.lookAt(bot.entity.position.offset(30, 1.62, 0), true);
  if (shield) { bot.activateItem(true); await ticks(5); }
  bot.setControlState("forward", true);
  if (sprint) bot.setControlState("sprint", true);
  await ticks(10);
  const start = bot.entity.position.x;
  const before = corrections;
  let shieldRaised = bot.usingHeldItem;
  for (let tick = 0; tick < 40; tick++) { await ticks(1); shieldRaised = shieldRaised && bot.usingHeldItem; }
  const blocksPerSecond = (bot.entity.position.x - start) / 2;
  bot.clearControlStates();
  if (shield) bot.deactivateItem();
  return { label, shieldRaised, blocksPerSecond, serverCorrections: corrections - before };
}
try {
  console.log(JSON.stringify([
    await leg("walk", false, false),
    await leg("walk with shield", true, false),
    await leg("sprint with shield", true, true),
    await leg("sprint after lowering", false, true),
  ]));
} finally {
  bot.clearControlStates();
  bot.off("forcedMove", corrected);
}
`;

/** Vanilla's LocalPlayer.USING_ITEM_SPEED_FACTOR. */
const ITEM_USE_FACTOR = 0.2;

export const run: ScenarioRun = async (context) => {
  await context.waitForTicks(20);
  const output = await context.call("debug_execute_javascript", { code: MEASURE_LEGS });
  const result = debugExecuteJavaScriptResultSchema.parse(output.result);
  assert.equal(result.status, "succeeded", output.summary);
  // The legs are logged as JSON: the returned value is rendered for reading, not parsing.
  const logged = (result.execution.logs.at(-1) ?? "[log] []").replace(/^\[log\] /u, "");
  const [walk, shielded, shieldedSprint, sprint] = JSON.parse(logged) as Leg[];
  const legs = [walk!, shielded!, shieldedSprint!, sprint!];
  for (const leg of legs) assert.equal(leg.serverCorrections, 0, `${leg.label}: the server corrected the bot's position`);
  assert.equal(walk!.shieldRaised, false);
  assert.equal(shielded!.shieldRaised, true, "the shield must stay raised for the whole measured walk");
  assert.equal(shieldedSprint!.shieldRaised, true, "the shield must stay raised for the whole measured sprint");
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) <= expected * 0.05, `${label}: ${actual.toFixed(3)} b/s, expected ${expected.toFixed(3)}`);
  close(shielded!.blocksPerSecond, walk!.blocksPerSecond * ITEM_USE_FACTOR, "walking with a raised shield");
  close(shieldedSprint!.blocksPerSecond, shielded!.blocksPerSecond, "sprinting with a raised shield");
  assert.ok(sprint!.blocksPerSecond > walk!.blocksPerSecond * 1.2, `lowering the shield must restore the sprint: ${sprint!.blocksPerSecond.toFixed(3)} b/s`);
  return {
    status: "succeeded",
    detail: legs.map((leg) => `${leg.label} ${leg.blocksPerSecond.toFixed(3)} b/s`).join("; "),
  };
};
