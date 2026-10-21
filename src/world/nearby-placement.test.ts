import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
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
