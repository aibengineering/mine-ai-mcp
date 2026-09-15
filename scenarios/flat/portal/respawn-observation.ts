import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Vec3 } from "vec3";
import type { ClientCompletion } from "mine-labs/client";
import { ActionRunner, createSleepAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const bed = new Vec3(20, -59, 0);

async function killAndWait(context: MineAiScenarioContext) {
  const spawned = new Promise<void>((resolve) => context.bot.once("spawn", resolve));
  context.bot.chat("/kill @s");
  await spawned;
  await context.bot.waitForTicks(2);
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const observations: Record<string, unknown> = {
    initialSpawnPoint: { ...bot.spawnPoint },
    initialPosition: { ...bot.entity.position },
  };
  const slept = await new ActionRunner().run(createSleepAction(bot, context.navigation), {}, context.signal);
  context.log(`sleep action: ${JSON.stringify(slept)}`);
  assert.equal(slept.result.status, "succeeded", JSON.stringify(slept));
  assert.ok("sleep" in slept.result && slept.result.sleep.respawnSet);
  observations.afterSleepSpawnPoint = { ...bot.spawnPoint };
  observations.sleepReceipt = slept;

  await killAndWait(context);
  context.log(`bed respawn: ${bot.entity.position}; spawnPoint=${bot.spawnPoint}`);
  observations.bedRespawnPosition = { ...bot.entity.position };
  observations.afterBedRespawnSpawnPoint = { ...bot.spawnPoint };
  assert.ok(bot.entity.position.distanceTo(bed) <= 4, `Expected bed respawn near ${bed}; got ${bot.entity.position}`);

  let spawnReset = false;
  bot.once("spawnReset", () => {
    spawnReset = true;
  });
  bot.chat(`/setblock ${bed.x} ${bed.y} ${bed.z} air`);
  bot.chat(`/setblock ${bed.x + 1} ${bed.y} ${bed.z} air`);
  await bot.waitForTicks(2);
  await killAndWait(context);
  context.log(`missing-bed respawn: ${bot.entity.position}; spawnPoint=${bot.spawnPoint}; spawnReset=${spawnReset}`);
  observations.missingBedRespawnPosition = { ...bot.entity.position };
  observations.afterMissingBedSpawnPoint = { ...bot.spawnPoint };
  observations.spawnReset = spawnReset;
  assert.ok(bot.entity.position.distanceTo(bed) > 8, "Destroyed bed must not remain the personal respawn point.");
  assert.equal(spawnReset, true, "Mineflayer must expose vanilla's missing-respawn-block signal.");

  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (artifacts) writeFileSync(path.join(artifacts, "respawn-observation.json"), JSON.stringify(observations, null, 2));
  return { status: "succeeded", detail: JSON.stringify(observations) };
}
