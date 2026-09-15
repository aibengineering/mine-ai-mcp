import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { blastBarrierCells } from "./blast-barrier.js";
import { blastBarrierScope } from "../../control/combat/scopes/blast-barrier.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { Answered } from "../../state/answered.js";

test("a blast barrier needs an exposed segment, attachment and an unoccupied cell", () => {
  const blocks: Record<string, string> = {};
  const bot = botFixture({ blocks, groundY: 63, position: new Vec3(0.5, 64, 0.5) });
  Object.assign(bot.entity, { type: "player", isValid: true });
  bot.entities[bot.entity.id] = bot.entity;
  const threats = [{ id: 7, position: new Vec3(3.5, 64, 0.5), distance: 3, swelling: true, observed: true }];
  bot.entities[7] = Object.assign({}, bot.entity, { id: 7, name: "creeper", type: "mob" as const, position: threats[0]!.position, width: 0.6, height: 1.7 });
  const cells = blastBarrierCells(bot, threats);
  assert.ok(cells.some(cell => cell.equals(new Vec3(1, 64, 0))));
  assert.ok(cells.every(cell => cell.x >= 1 && cell.x < 3), "never place into the player's body");
  blocks["1,64,0"] = "stone";
  blocks["1,65,0"] = "stone";
  assert.deepEqual(blastBarrierCells(bot, threats), [], "existing protection is not thickened");
});

test("a refused blast barrier is reopened by its placement facts, not quarry or player movement", () => {
  const blocks: Record<string, string> = {};
  const bot = botFixture({ blocks, groundY: 63, items: [{ name: "cobblestone", count: 8 }] });
  const scope = blastBarrierScope(bot, new Vec3(1, 64, 0), () => DEFAULT_COMBAT_POLICY);
  const answered = new Answered();
  answered.remember(scope, { kind: "placement_failed", why: "fixture server refused placement" });
  bot.entity.position.x += 1;
  assert.ok(answered.find(scope.capability, scope.scope));
  blocks["1,63,0"] = "air";
  assert.equal(answered.find(scope.capability, scope.scope), null);
});
