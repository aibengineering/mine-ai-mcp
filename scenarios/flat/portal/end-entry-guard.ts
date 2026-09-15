import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ClientCompletion } from "mine-labs/client";
import { ActionRunner, createEnterEndPortalAction, createSleepAction } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const mode = String(context.scenario.params.mode);
  const runner = new ActionRunner();
  const receipts: unknown[] = [];
  await context.bot.waitForChunksToLoad();
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      assert.equal(context.bot.blockAt(new Vec3(x, -59, z))?.name, "end_portal", `Missing End portal at ${x},-59,${z}`);
    }
  }
  const framePositions = [
    ...[-1, 0, 1].flatMap((x) => [new Vec3(x, -59, -2), new Vec3(x, -59, 2)]),
    ...[-1, 0, 1].flatMap((z) => [new Vec3(-2, -59, z), new Vec3(2, -59, z)]),
  ];
  for (const position of framePositions) {
    assert.equal(context.bot.blockAt(position)?.name, "end_portal_frame", `Missing End portal frame at ${position}`);
  }
  if (mode === "near" || mode === "distant") {
    const bedX = mode === "near" ? -7 : -30;
    assert.match(context.bot.blockAt(new Vec3(bedX, -59, 0))?.name ?? "", /_bed$/, "Fixture bed foot must be loaded before sleep");
    assert.match(context.bot.blockAt(new Vec3(bedX + 1, -59, 0))?.name ?? "", /_bed$/, "Fixture bed head must be loaded before sleep");
    const slept = await runner.run(createSleepAction(context.bot, context.navigation), {}, context.signal);
    receipts.push(slept);
    assert.equal(slept.result.status, "succeeded", JSON.stringify(slept));
    assert.ok("sleep" in slept.result && slept.result.sleep.morning && slept.result.sleep.respawnSet);
  }
  const request = {
    x: 0, y: -59, z: 0,
    ...(mode === "distant" ? { respawn_within: 8 } : {}),
    ...(mode === "override" ? { allow_distant_respawn: true } : {}),
  };
  const entered = await runner.run(createEnterEndPortalAction(context.bot, context.navigation), request, context.signal);
  receipts.push(entered);
  context.log(`${mode}: ${JSON.stringify(entered)}`);
  if (mode === "missing") {
    assert.equal(entered.result.status, "failed");
    assert.match("error" in entered.result ? entered.result.error : "", /END_PORTAL_RESPAWN_UNKNOWN/);
    assert.equal(context.bot.game.dimension, "overworld");
  } else if (mode === "distant") {
    assert.equal(entered.result.status, "failed");
    assert.match("error" in entered.result ? entered.result.error : "", /END_PORTAL_RESPAWN_DISTANT/);
    assert.equal(context.bot.game.dimension, "overworld");
  } else {
    assert.equal(entered.result.status, "succeeded", JSON.stringify(entered));
    assert.equal(context.bot.game.dimension, "the_end");
    assert.ok("navigation" in entered.result && entered.result.navigation.remainingDistance === null);
  }
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (artifacts) writeFileSync(path.join(artifacts, `end-entry-${mode}.json`), JSON.stringify({ mode, receipts, dimension: context.bot.game.dimension }, null, 2));
  return { status: "succeeded", detail: `${mode} guard behavior observed; dimension=${context.bot.game.dimension}` };
}
