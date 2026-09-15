import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Vec3 } from "vec3";
import type { ClientCompletion } from "mine-labs/client";
import {
  ActionRunner,
  createActivatePortalAction,
  createEnterEndPortalAction,
  createNavigateAction,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, navigation, signal, log } = context;
  const runner = new ActionRunner();
  await bot.waitForChunksToLoad();
  const healthBefore = bot.health;
  const activated = await runner.run(
    createActivatePortalAction(bot, navigation),
    { x: -2, y: -59, z: 0 },
    signal,
  );
  assert.equal(activated.result.status, "succeeded", JSON.stringify(activated));
  assert.equal(bot.game.dimension, "overworld", "Activation must not enter the portal.");
  assert.equal(bot.blockAt(new Vec3(0, -59, 0))?.name, "end_portal");
  assert.equal(
    bot.blockAt(new Vec3(0, -60, 0))?.name,
    "lava",
    "Entry must not depend on solid footing in the opening.",
  );

  const enterEnd = createEnterEndPortalAction(bot, navigation);
  const crossed = await runner.run(
    enterEnd,
    { x: 0, y: -59, z: 0, allow_distant_respawn: true },
    signal,
  );
  log(JSON.stringify(crossed));
  assert.equal(crossed.result.status, "succeeded", JSON.stringify(crossed));
  assert.ok("navigation" in crossed.result);
  assert.equal(crossed.result.navigation.startDimension, "overworld");
  assert.equal(crossed.result.navigation.endDimension, "the_end");
  assert.equal(crossed.result.navigation.remainingDistance, null);
  assert.equal(bot.game.dimension, "the_end");
  const arrival = bot.entity.position.clone();
  assert.ok(
    arrival.x > 90 && arrival.y > 40,
    "Receipt must contain the new server position, not the old portal coordinates.",
  );
  await bot.waitForChunksToLoad();
  const feet = bot.entity.position.floored();
  assert.equal(bot.blockAt(feet.offset(0, -1, 0))?.name, "obsidian");
  assert.equal(bot.health, healthBefore, "The step must not fall into the lava below the portal.");

  // A second ordinary navigation proves controls and world observation survived the crossing.
  const navigate = createNavigateAction(bot, navigation);
  const walked = await runner.run(
    navigate,
    { x: feet.x + 1, y: feet.y, z: feet.z, range: 0, dig: false, scaffold: false },
    signal,
  );
  assert.equal(walked.result.status, "succeeded", JSON.stringify(walked));
  assert.equal(bot.game.dimension, "the_end");
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (artifacts)
    writeFileSync(
      path.join(artifacts, "end-crossing-evidence.json"),
      JSON.stringify({ activated, crossed, walked, arrival, healthBefore, healthAfter: bot.health }, null, 2),
    );
  return {
    status: "succeeded",
    detail:
      "Activated over lava, entered the End through navigate with default range, observed the arrival platform without damage, then navigated again in the End.",
  };
}
