/**
 * Build, light, and walk through a nether portal, through the same actions
 * the MCP model would call, and report the dimension the bot ends up in.
 * The frame is one build call; the order and the supports are its problem.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  attachHighlighter,
  createBuildStructureAction,
  createActivatePortalAction,
  createEnterNetherPortalAction,
  createNavigateAction,
  ActionRunner,
  type Action,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";

import type { MineAiScenarioContext } from "./scenario-client.ts";

const paramsSchema = z.strictObject({
  interior: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const build = createBuildStructureAction(bot, context.navigation);
  const activate = createActivatePortalAction(bot, context.navigation);
  const enterNether = createEnterNetherPortalAction(bot, context.navigation);
  const steps: string[] = [];

  const step = async (label: string, request: Record<string, unknown>, action: Action) => {
    const { result, durationMs } = await runner.run(action, request, context.signal);
    const error = "error" in result ? result.error : "";
    const line = `${label}: ${result.status} in ${durationMs} ms${error ? ` — ${error}` : ""}`;
    steps.push(line);
    context.log(line);
    return result;
  };

  const built = await step("build frame", { portal_frame: { ...params.interior, axis: "x" } }, build);
  if (built.status !== "succeeded") return { status: "failed", detail: steps.join("; ") };

  const lit = await step("activate", { ...params.interior, y: params.interior.y - 1 }, activate);
  if (lit.status !== "succeeded") return { status: "failed", detail: steps.join("; ") };

  const before = bot.game.dimension;
  assert.equal(before, "overworld", "Activation must leave the bot outside the portal.");
  const positionBefore = bot.entity.position.clone();
  const request = { ...params.interior };
  const warned = await runner.run(enterNether, request, context.signal);
  assert.equal(warned.result.status, "failed", JSON.stringify(warned));
  assert.ok("error" in warned.result && warned.result.error.includes("PORTAL_LOW_SUPPLIES"));
  assert.equal(bot.game.dimension, before);
  assert.ok(bot.entity.position.distanceTo(positionBefore) < 0.2, "Supply refusal must not walk into the portal.");
  context.log(`Supply warning: ${JSON.stringify(warned)}`);

  const entered = await runner.run(enterNether, { ...request, allow_low_supplies: true }, context.signal);
  context.log(`Crossing receipt: ${JSON.stringify(entered)}`);
  assert.equal(entered.result.status, "succeeded", JSON.stringify(entered));
  assert.ok("navigation" in entered.result);
  assert.equal(entered.result.navigation.startDimension, "overworld");
  assert.equal(entered.result.navigation.endDimension, "the_nether");
  assert.equal(entered.result.navigation.remainingDistance, null);
  assert.equal(bot.game.dimension, "the_nether", "The action itself must await the transfer.");
  assert.deepEqual(entered.result.navigation.end, {
    x: bot.entity.position.x,
    y: bot.entity.position.y,
    z: bot.entity.position.z,
  });
  await bot.waitForChunksToLoad();
  const returnCell = bot.findBlock({ matching: (block) => block.name === "nether_portal", maxDistance: 32 });
  assert.ok(returnCell, "Generated Nether arrival must contain a return portal.");
  const immediateReturn = await runner.run(
    enterNether,
    { x: returnCell.position.x, y: returnCell.position.y, z: returnCell.position.z },
    context.signal,
  );
  assert.equal(immediateReturn.result.status, "failed", JSON.stringify(immediateReturn));
  assert.match("error" in immediateReturn.result ? immediateReturn.result.error : "", /PORTAL_ALREADY_INSIDE/);
  // Vanilla applies a portal cooldown after arrival. Leave the opening and let
  // that native cooldown expire before asking for the independent return trip.
  const arrivalFeet = bot.entity.position.floored();
  const exits: Vec3[] = [];
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      const feet = arrivalFeet.offset(dx, 0, dz);
      const clear = bot.blockAt(feet)?.boundingBox === "empty" && bot.blockAt(feet.offset(0, 1, 0))?.boundingBox === "empty";
      const supported = bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === "block";
      const away = feet.distanceTo(returnCell.position) >= 3;
      if (clear && supported && away) exits.push(feet);
    }
  }
  exits.sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position));
  const exit = exits[0];
  assert.ok(exit, "Generated Nether arrival must expose a loaded standable cell outside the return portal.");
  const cleared = await runner.run(
    createNavigateAction(bot, context.navigation),
    { x: exit.x, y: exit.y, z: exit.z, range: 1 },
    context.signal,
  );
  assert.equal(cleared.result.status, "succeeded", JSON.stringify(cleared));
  assert.notEqual(bot.blockAt(bot.entity.position.floored())?.name, "nether_portal", "Cooldown wait must occur outside the portal opening.");
  await bot.waitForTicks(220);
  const returned = await runner.run(
    enterNether,
    { x: returnCell.position.x, y: returnCell.position.y, z: returnCell.position.z },
    context.signal,
  );
  context.log(`Return receipt: ${JSON.stringify(returned)}`);
  assert.equal(returned.result.status, "succeeded", JSON.stringify(returned));
  assert.equal(bot.game.dimension, "overworld", "Return must be supply-exempt and await Overworld positioning.");
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (artifacts)
    writeFileSync(path.join(artifacts, "nether-crossing-evidence.json"), JSON.stringify({ warned, entered, immediateReturn, returned }, null, 2));
  return {
    status: "succeeded",
    detail: `Supply warning stopped movement; explicit override returned a positioned Nether arrival; supply-exempt return reached the Overworld. ${steps.join("; ")}`,
  };
}
