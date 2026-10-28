import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { chooseCell } from "./nearby-placement.js";

// hunt/wild-animal-and-receipts: an uncoordinated place_block on seed 8675309
// chose the floor cell a wandering pig stood in, (19, 66, -18) with the pig at
// (19.50, 66, -16.74), and the placement was then refused for the overlap. The
// cell is chosen around the bot, so a mob in it rules it out before the choice.
test("the nearest clear cell skips one a mob stands in", () => {
  const pig = { id: 48, name: "pig", type: "animal", isValid: true, position: new Vec3(-0.5, 64, 0.5), width: 0.9, height: 0.9 };
  const open = botFixture({ groundY: 63 });
  const crowded = botFixture({ groundY: 63, entities: { 48: pig } });

  const first = chooseCell(open, "cobblestone", 3);
  assert.deepEqual(first?.position, new Vec3(-1, 64, 0), "with nothing in the way the west floor cell is nearest");
  const chosen = chooseCell(crowded, "cobblestone", 3);
  assert.ok(chosen, "another floor cell is just as near");
  assert.notDeepEqual(chosen.position, new Vec3(-1, 64, 0));
  assert.equal(chosen.position.distanceTo(new Vec3(0, 64, 0)), 1);
});

// progression-to-diamond@3 (merge-recheck 2026-10-25T09-57-07-322Z-t00007):
// collect_block reached the iron at 1614,65,1579 by digging straight down from
// the surface at y 71 and stood in the ore's cell, at (1614.51, 65, 1579.45).
// Every cell at feet level and the step down was stone, the step up was the
// bot's own head, and the temporary furnace failed with no_cell. The shaft
// above the head is clear and within reach.
test("at the bottom of a one-wide shaft the cell over the head is chosen", () => {
  const shaft: Record<string, string> = {};
  for (let y = 65; y <= 70; y += 1) shaft[`1614,${y},1579`] = "air";
  const bot = botFixture({ groundY: 70, blocks: shaft, position: new Vec3(1614.51, 65, 1579.45) });

  const chosen = chooseCell(bot, "furnace", 3);
  assert.deepEqual(chosen?.position, new Vec3(1614, 67, 1579));
});

test("the cell over the head is not chosen while a nearer cell is clear", () => {
  const bot = botFixture({ groundY: 63 });
  const chosen = chooseCell(bot, "furnace", 3);
  assert.equal(chosen?.position.y, 64, "open ground keeps a floor cell at feet level");
});
