import assert from "node:assert/strict";
import { z } from "zod";
import { viewBlocksResultSchema, viewStatusResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ScenarioCall, ScenarioContext, ScenarioRun } from "../scenario.ts";

const positionSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
/** The frame's interior: its lowest, nearest cell, one above the floor; the frame spans x from here. */
const paramsSchema = z.strictObject({ interior: positionSchema, cooldownTicks: z.number().int().positive() });

const OPEN = new Set(["air", "cave_air"]);
const UNSAFE_FLOOR = new Set(["air", "cave_air", "lava", "fire", "soul_fire", "nether_portal", "magma_block"]);

async function situation(context: ScenarioContext) {
  return viewStatusResultSchema.parse((await context.call("view_status", {})).result).situation;
}

function succeeded(output: ScenarioCall) {
  assert.equal(output.result.status, "succeeded", output.summary);
}

function refused(output: ScenarioCall, code: string) {
  assert.ok(output.result.status === "failed" && output.result.error.includes(code), `Expected ${code}; ${output.summary}`);
}

/**
 * Build and light a Nether portal from the carried obsidian, cross only with
 * the supply override, refuse to re-enter from inside the arrival portal, and
 * return once vanilla's portal cooldown has passed outside it. The return
 * portal is found at run time, as any caller would find it.
 */
export const run: ScenarioRun = async (context) => {
  const { interior, cooldownTicks } = paramsSchema.parse(context.scenario.params);
  succeeded(await context.call("build_structure", { portal_frame: { ...interior, axis: "x" } }));
  succeeded(await context.call("activate_portal", { ...interior, y: interior.y - 1 }));

  const before = await situation(context);
  assert.equal(before.dimension, "overworld", "Activation must leave the bot outside the portal.");
  refused(await context.call("enter_nether_portal", interior), "PORTAL_LOW_SUPPLIES");
  const held = await situation(context);
  assert.equal(held.dimension, "overworld");
  assert.ok(Math.hypot(held.position.x - before.position.x, held.position.y - before.position.y, held.position.z - before.position.z) < 0.2,
    "A supply refusal must not walk into the portal.");

  succeeded(await context.call("enter_nether_portal", { ...interior, allow_low_supplies: true }));
  const arrival = await situation(context);
  assert.equal(arrival.dimension, "the_nether", "The crossing must await the transfer.");

  // The Nether's chunks arrive after the transfer; observe until they hold the return portal.
  const findPortal = async () => viewBlocksResultSchema.parse(
    (await context.call("view_blocks", { find: { block_names: ["nether_portal"], limit: 1 } })).result);
  let found = await findPortal();
  for (let look = 0; look < 15 && !found.blocks.find?.[0]?.listed[0]; look++) {
    await context.waitForTicks(20);
    found = await findPortal();
  }
  const portal = found.blocks.find?.[0]?.listed[0];
  assert.ok(portal, "The Nether arrival must contain a return portal.");
  const returnCell = { x: portal.x, y: portal.y, z: portal.z };
  refused(await context.call("enter_nether_portal", returnCell), "PORTAL_ALREADY_INSIDE");

  // Leave the opening before waiting out the cooldown: a standable cell at least three blocks from the portal.
  const feet = found.blocks.feet;
  const box = viewBlocksResultSchema.parse((await context.call("view_blocks", { box: { ...feet, half_width: 4, half_height: 1 } })).result).blocks.box!;
  const at = (y: number, z: number, x: number) => {
    const layer = box.layers.find((entry) => entry.y === y);
    return layer?.rows.find((row) => row.z === z)?.blocks[x - (box.center.x - box.halfWidth)];
  };
  const exits: { x: number; y: number; z: number }[] = [];
  for (let x = box.center.x - box.halfWidth; x <= box.center.x + box.halfWidth; x++)
    for (let z = box.center.z - box.halfWidth; z <= box.center.z + box.halfWidth; z++) {
      const y = box.center.y;
      const clear = OPEN.has(at(y, z, x) ?? "") && OPEN.has(at(y + 1, z, x) ?? "");
      const floor = at(y - 1, z, x);
      const away = Math.hypot(x - returnCell.x, z - returnCell.z) >= 3;
      if (clear && floor !== undefined && !UNSAFE_FLOOR.has(floor) && away) exits.push({ x, y, z });
    }
  exits.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z));
  assert.ok(exits[0], "The arrival must offer a standable cell outside the return portal.");
  succeeded(await context.call("navigate", { ...exits[0], range: 1 }));
  await context.waitForTicks(cooldownTicks);

  succeeded(await context.call("enter_nether_portal", returnCell));
  assert.equal((await situation(context)).dimension, "overworld", "The return is supply-exempt and must reach the Overworld.");
  return { status: "succeeded", detail: "Built and lit the portal, refused low supplies in place, crossed, refused re-entry from inside, and returned." };
};
