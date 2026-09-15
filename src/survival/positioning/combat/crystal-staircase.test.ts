import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import type { NavigationRuntime } from "../../../navigation/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { buildCrystalStaircase, pillarShortfall, planCrystalStaircase, staircaseShortfall } from "./crystal-staircase.js";

/** A native spike: obsidian strictly below the bedrock pedestal, the crystal one above it, and only the two narrow towers caged. */
for (const radius of [2, 3, 5]) test(`radius ${radius} staircase preserves its layout after construction and counts only missing treads`, async () => {
  const blocks: Record<string, string> = {};
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) blocks[`${x},60,${z}`] = "end_stone";
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++)
    if (x*x+z*z <= radius*radius + 1) for (let y = 61; y < 89; y++) blocks[`${x},${y},${z}`] = "obsidian";
  blocks["0,89,0"] = "bedrock";
  if (radius === 2)
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 89; y <= 92; y++)
      if (Math.abs(x) === 2 || Math.abs(z) === 2 || y === 92) blocks[`${x},${y},${z}`] = "iron_bars";
  const items = [{ name: "end_stone", count: 0 }];
  const bot = botFixture({ blocks, items });
  const readBlock = bot.blockAt.bind(bot);
  bot.blockAt = position => readBlock(position.floored());
  const crystal = new Vec3(0.5, 90, 0.5);
  const plan = planCrystalStaircase(bot, crystal);
  assert.match(staircaseShortfall(bot, plan)!, /CRYSTAL_STAIRCASE_SHORTFALL.*carrying 0.*Gather at least.*approach "pillar".*about \d+ carried scaffold blocks/);
  assert.equal(plan.pillarBlocks, 88 - 60 - 1, "a pillar from the island surface to the rim's feet level");
  assert.match(pillarShortfall(bot, DEFAULT_SURVIVAL_POLICY, plan)!, /CRYSTAL_PILLAR_SHORTFALL.*about 27 scaffold blocks.*carrying 0/);
  assert.match(pillarShortfall(bot, { ...DEFAULT_SURVIVAL_POLICY, combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig: true, place: false } } }, plan)!, /CRYSTAL_PILLAR_CONSTRAINED/);
  items[0]!.count = 27;
  assert.equal(pillarShortfall(bot, DEFAULT_SURVIVAL_POLICY, plan), null);
  items[0]!.count = 0;
  assert.equal(plan.cells.some(cell => cell.blockName === "air" && cell.position.x === 0 && cell.position.z === 0), false, "never excavate the blast-cover pedestal column");
  assert.equal(plan.cells.some(cell => cell.blockName === "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name === "obsidian"), false,
    "the tower is never mined");
  assert.ok(plan.tower.length > 0 && plan.tower.every(cell => bot.blockAt(cell)?.name === "obsidian"), "the protected top layers are the tower's own obsidian");
  if (radius <= 3) {
    // The rim one below the pedestal's top face is within reach: full cover, feet outside the top layer.
    assert.deepEqual(plan.stance, new Vec3(2, 88, -radius));
    assert.equal(plan.covered, true);
    assert.equal(bot.blockAt(plan.stance)?.name, "air");
  } else {
    // Out of reach from the rim: swing from the top layer's far diagonal, standing on native obsidian.
    assert.deepEqual(plan.stance, new Vec3(3, 89, -3));
    assert.equal(plan.covered, false);
    assert.equal(bot.blockAt(plan.stance.offset(0, -1, 0))?.name, "obsidian");
    assert.equal(plan.cells.some(cell => cell.position.y >= 89 && cell.blockName !== "air" && (cell.position.x !== 0 || cell.position.z !== 0)), false,
      "nothing is built on the top layer; only head clearance and the retained pedestal are recorded there");
  }
  assert.equal(plan.cells.filter(cell => cell.blockName === "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name === "iron_bars").length, radius === 2 ? 1 : 0,
    "open only the corner bar needed for standing clearance on a caged tower");
  let wallTreads = 0, cornerSupports = 0;
  for (const cell of plan.cells.filter(cell => cell.blockName === "end_stone" && cell.position.y > 60)) {
    const position = new Vec3(cell.position.x, cell.position.y, cell.position.z);
    const below = plan.cells.find(other => position.offset(0, -1, 0).equals(new Vec3(other.position.x, other.position.y, other.position.z)));
    const above = plan.cells.find(other => position.offset(0, 1, 0).equals(new Vec3(other.position.x, other.position.y, other.position.z)));
    const againstWall = [position.offset(1, 0, 0), position.offset(-1, 0, 0), position.offset(0, 0, 1), position.offset(0, 0, -1)]
      .some(neighbor => bot.blockAt(neighbor)?.name === "obsidian");
    if (againstWall && above?.blockName === "air") {
      wallTreads++;
      assert.equal(below, undefined, "wall-attached treads need no lower support");
    }
    if (above?.blockName === "end_stone") cornerSupports++;
  }
  assert.ok(wallTreads > 0 && cornerSupports > 0, "exercise both wall attachment and supported corners");
  for (const cell of plan.cells) blocks[`${cell.position.x},${cell.position.y},${cell.position.z}`] = cell.blockName;
  assert.equal(staircaseShortfall(bot, plan), null);
  assert.equal(await buildCrystalStaircase(bot, {} as NavigationRuntime, { ...DEFAULT_SURVIVAL_POLICY,
    combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig: false, place: false } },
  }, plan, new AbortController().signal), null, "existing stairs need no placement permission or route work");
  const rebuilt = planCrystalStaircase(bot, crystal);
  assert.deepEqual(rebuilt, plan, "a new crystal request must regenerate the same layout");
  for (const cell of plan.cells.filter(cell => cell.blockName === "end_stone").slice(-2))
    blocks[`${cell.position.x},${cell.position.y},${cell.position.z}`] = "air";
  assert.match(staircaseShortfall(bot, rebuilt)!, /2 end_stone blocks still needed; carrying 0/);
  items[0]!.count = 2;
  assert.equal(staircaseShortfall(bot, rebuilt), null);
});
