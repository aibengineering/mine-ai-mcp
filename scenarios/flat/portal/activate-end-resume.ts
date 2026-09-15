import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Vec3 } from "vec3";
import type { BotEvents } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import { ActionRunner, createActivatePortalAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, navigation, signal, log } = context;
  const runner = new ActionRunner();
  const request = { x: 0, y: -59, z: -2 };
  const sockets: Vec3[] = [];
  const interior: Vec3[] = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    sockets.push(
      new Vec3(offset, -59, -2),
      new Vec3(offset, -59, 2),
      new Vec3(-2, -59, offset),
      new Vec3(2, -59, offset),
    );
    for (let z = -1; z <= 1; z += 1) interior.push(new Vec3(offset, -59, z));
  }
  const filled = () => sockets.filter((cell) => bot.blockAt(cell)?.getProperties().eye === true).length;
  const carried = () =>
    bot.inventory
      .items()
      .filter((item) => item.name === "ender_eye")
      .reduce((sum, item) => sum + item.count, 0);
  const snapshots: unknown[] = [];
  await bot.waitForChunksToLoad();
  assert.equal(filled(), 2);
  assert.equal(carried(), 10);
  const stop = new AbortController();
  const cancel: BotEvents["blockUpdate"] = (_old, block) => {
    if (block?.name === "end_portal_frame" && filled() === 5) stop.abort("Scenario: cancel after three insertions.");
  };
  bot.on("blockUpdate", cancel);
  try {
    const output = await runner.run(
      createActivatePortalAction(bot, navigation),
      request,
      AbortSignal.any([signal, stop.signal]),
    );
    snapshots.push(output);
    assert.equal(output.result.status, "cancelled", JSON.stringify(output));
  } finally {
    bot.off("blockUpdate", cancel);
  }
  // The inventory update follows the socket update on the same server tick.
  await bot.waitForTicks(2);
  assert.equal(filled(), 5);
  assert.equal(carried(), 7);
  log("Cancelled after three confirmed insertions; five sockets filled, seven eyes carried.");
  const resumed = await runner.run(createActivatePortalAction(bot, navigation), request, signal);
  snapshots.push(resumed);
  log(JSON.stringify(resumed));
  assert.equal(resumed.result.status, "succeeded", JSON.stringify(resumed));
  assert.equal(filled(), 12);
  assert.equal(carried(), 0);
  assert.ok(interior.every((cell) => bot.blockAt(cell)?.name === "end_portal"));
  assert.equal(bot.game.dimension, "overworld");
  const feet = bot.entity.position;
  assert.ok(
    feet.x + 0.3 <= -1 || feet.x - 0.3 >= 2 || feet.z + 0.3 <= -1 || feet.z - 0.3 >= 2,
    "Bot body must remain outside the opening.",
  );
  const repeated = await runner.run(createActivatePortalAction(bot, navigation), request, signal);
  snapshots.push(repeated);
  assert.equal(repeated.result.status, "succeeded", JSON.stringify(repeated));
  assert.ok("portal" in repeated.result && repeated.result.portal.kind === "end" && !repeated.result.portal.activated);
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (artifacts)
    writeFileSync(
      path.join(artifacts, "portal-evidence.json"),
      JSON.stringify({ snapshots, feet, dimension: bot.game.dimension, eyes: carried() }, null, 2),
    );
  return {
    status: "succeeded",
    detail:
      "Cancelled after three insertions, resumed seven, observed nine portal blocks, and repeated with zero eyes. Stayed in the Overworld.",
  };
}
