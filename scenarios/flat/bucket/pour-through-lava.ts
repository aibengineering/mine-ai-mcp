/**
 * The one vanilla fact the cast is built on, measured rather than recalled.
 *
 * A full bucket's ray ignores fluid, stops at the first solid face, and the
 * water lands in the cell in front of that face. So looking straight through a
 * lava source at the pool floor should put the water in the lava cell itself,
 * turn the sources around it to obsidian, and leave a water source the empty
 * bucket's own ray can take back from the same cell.
 *
 * `pourAim` in `world/liquid.ts` is that rule; this fixture is why it is
 * allowed to aim through lava at all.
 */
import { Vec3 } from "vec3";
import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** The lava source the pour is aimed through. */
const SOURCE = new Vec3(4, -60, 0);
/** The pool floor under it; its top face is what the ray lands on. */
const FLOOR = new Vec3(4, -61, 0);
/** The sources touching the landing cell, which are what turn to obsidian. */
const RING = [new Vec3(5, -60, 0), new Vec3(4, -60, 1), new Vec3(4, -60, -1)];

/** How long the pour and the scoop are each given to show in the world. */
const USE_TICKS = 40;

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  for (let waited = 0; waited < 100 && !bot.entity.onGround; waited += 1) await bot.waitForTicks(1);
  await bot.waitForTicks(20);

  const name = (cell: Vec3) => bot.blockAt(cell)?.name ?? "unloaded";
  const use = async (item: { name: string }, lookAt: Vec3) => {
    await bot.equip(item as never, "hand");
    await bot.lookAt(lookAt, true);
    bot.activateItem();
    await bot.waitForTicks(USE_TICKS);
    if (bot.usingHeldItem) bot.deactivateItem();
  };
  const carried = (item: string) => bot.inventory.items().find((held) => held.name === item);

  context.log(`before: landing=${name(SOURCE)} floor=${name(FLOOR)} ring=${RING.map(name).join(",")}`);
  const water = carried("water_bucket");
  if (!water) return { status: "failed", detail: "no water bucket in the inventory" };

  // The top face of the pool floor, seen through the lava: the landing cell is
  // that floor cell plus the face normal, which is the lava source itself.
  await use(water, FLOOR.offset(0.5, 1, 0.5));
  const landing = name(SOURCE);
  const ring = RING.map(name);
  context.log(`after pour: landing=${landing} ring=${ring.join(",")} hand=${bot.heldItem?.name ?? "empty"}`);

  const bucket = carried("bucket");
  if (bucket) await use(bucket, SOURCE.offset(0.5, 0.9, 0.5));
  const recovered = carried("water_bucket") !== undefined;
  context.log(`after scoop: landing=${name(SOURCE)} hand=${bot.heldItem?.name ?? "empty"}`);

  const obsidian = ring.filter((formed) => formed === "obsidian").length;
  const detail = `landing=${landing}; obsidian ring ${obsidian}/${RING.length}; water recovered ${recovered}`;
  return { status: landing === "water" && obsidian === RING.length && recovered ? "succeeded" : "failed", detail };
}
