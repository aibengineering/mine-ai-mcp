import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { worldViewRaycaster } from "../../../navigation/world/line-of-sight.js";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { observation, planningStart } from "../../../test-support/navigation.js";
import {
  crystalBlastCoverCell,
  crystalBlastCovered,
  crystalBlastEstimate,
  crystalMeleeAim,
  crystalMeleeAimFrom,
  crystalReturnGoal,
} from "./crystal-melee.js";

const registry = minecraftData("1.21.4"),
  Block = prismarineBlock("1.21.4");
const crystal = new Vec3(0.5, 83, 0.5);
function fixture(pedestal: string | null = "bedrock") {
  const blocks = new Map<string, string>();
  if (pedestal) blocks.set("(0, 82, 0)", pedestal);
  const blockAt = (position: Vec3) => {
    const p = position.floored(),
      name = blocks.get(p.toString()) ?? "air";
    const block = Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);
    block.position = p;
    return block;
  };
  const rays = worldViewRaycaster((x, y, z) =>
    blockAt(new Vec3(x, y, z)).shapes.map(([minX, minY, minZ, maxX, maxY, maxZ]) => ({
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    })),
  );
  const slots: Record<number, { name: string } | null> = {};
  const bot = { blockAt, world: rays, entity: { position: new Vec3(2.5, 81, 2.5) }, inventory: { slots } } as unknown as Bot;
  return { bot, blocks, rays, slots };
}

/** The top obsidian layer of a native tower sits one block below its bedrock pedestal. */
function tower(blocks: Map<string, string>, radius: number) {
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++)
      if (x * x + z * z <= radius * radius + 1) blocks.set(new Vec3(x, 81, z).toString(), "obsidian");
}

test("native pedestal cover blocks every standing-player explosion sample from all approach corners", () => {
  const { bot, rays } = fixture();
  for (const x of [-2.5, 3.5])
    for (const z of [-2.5, 3.5]) {
      const feet = new Vec3(x, 81, z);
      assert.equal(crystalBlastCovered(bot, crystal, feet), true);
      // Independently cast Minecraft's 45 body-exposure rays toward the blast.
      const horizontalStep = 1 / (0.6 * 2 + 1),
        verticalStep = 1 / (1.8 * 2 + 1);
      const offset = (1 - Math.floor(1 / horizontalStep) * horizontalStep) / 2;
      for (let a = 0; a <= 1; a += horizontalStep)
        for (let b = 0; b <= 1; b += verticalStep)
          for (let c = 0; c <= 1; c += horizontalStep) {
            const from = feet.offset(-0.3 + a * 0.6 + offset, b * 1.8, -0.3 + c * 0.6 + offset);
            const delta = crystal.minus(from),
              distance = delta.norm();
            assert.ok(rays.raycast(from, delta.scaled(1 / distance), distance));
          }
      assert.deepEqual(crystalBlastEstimate(bot, crystal, feet), { covered: true, exposure: 0, rawDamage: 1, damage: 1 });
    }
});

test("cover rejects an exposed head, missing pedestal, fragile block and floating crystal", () => {
  assert.equal(crystalBlastCovered(fixture().bot, crystal, new Vec3(2.5, 82, 2.5)), false);
  for (const pedestal of [null, "cobblestone"])
    assert.equal(crystalBlastCovered(fixture(pedestal).bot, crystal, new Vec3(2.5, 81, 2.5)), false);
  assert.equal(crystalBlastCovered(fixture().bot, crystal.offset(0, 0.5, 0), new Vec3(2.5, 81, 2.5)), false);
});

test("melee evidence identifies the observed pedestal", () => {
  const { bot } = fixture();
  assert.deepEqual(crystalBlastCoverCell(bot, crystal, new Vec3(2.5, 81, 2.5)), new Vec3(0, 82, 0));
  assert.equal(crystalBlastCoverCell(bot, crystal, new Vec3(2.5, 82, 2.5)), null);
});

test("on the tower top the pedestal still shields the lower body, and armor decides whether the hit is survivable", () => {
  const { bot, blocks, slots } = fixture();
  tower(blocks, 5);
  const feet = new Vec3(3.5, 82, -2.5);
  bot.entity.position = feet;
  assert.equal(bot.blockAt(feet.offset(0, -1, 0))?.name, "obsidian", "standing on the top layer");
  assert.ok(crystalMeleeAim(bot, crystal), "the crystal is within reach from the rim of the top layer");
  const bare = crystalBlastEstimate(bot, crystal, feet);
  assert.equal(bare.covered, false);
  // Two of the five sample rows sit above the pedestal's top face: 18 of 45 rays reach the body.
  assert.ok(Math.abs(bare.exposure - 0.4) < 0.001, `exposure ${bare.exposure}`);
  // sqrt(19) blocks from the blast centre over a radius of twelve, then the server's damage curve.
  const impact = (1 - Math.sqrt(19) / 12) * 0.4;
  assert.equal(bare.rawDamage, Math.floor(((impact * impact + impact) / 2) * 7 * 12 + 1));
  assert.equal(bare.rawDamage, 14);
  assert.equal(bare.damage, 14, "no armor, no reduction");
  for (const [slot, name] of [[5, "diamond_helmet"], [6, "diamond_chestplate"], [7, "diamond_leggings"], [8, "diamond_boots"]] as const)
    slots[slot] = { name };
  const armored = crystalBlastEstimate(bot, crystal, feet);
  assert.equal(armored.rawDamage, 14);
  // Twenty armor points, toughness eight: 20 - 14 / (2 + 2) = 16.5 points, 66% off.
  assert.ok(Math.abs(armored.damage - 14 * (1 - 16.5 / 25)) < 0.001, `damage ${armored.damage}`);
});

test("standing level with the crystal without a pedestal between is fully exposed", () => {
  const { bot } = fixture();
  const feet = new Vec3(3.5, 83, 0.5);
  const estimate = crystalBlastEstimate(bot, crystal, feet);
  assert.equal(estimate.exposure, 1);
  assert.ok(estimate.rawDamage > 40, `raw ${estimate.rawDamage}`);
});

test("melee requires an exposed ray within three blocks after the cage cell is excavated", () => {
  const { bot, blocks } = fixture();
  blocks.set("(2, 82, 2)", "iron_bars");
  assert.equal(crystalMeleeAim(bot, crystal), null);
  blocks.delete("(2, 82, 2)");
  assert.ok(crystalMeleeAim(bot, crystal));
  bot.entity.position = new Vec3(8.5, 81, 2.5);
  assert.equal(crystalMeleeAim(bot, crystal), null);
  assert.ok(crystalMeleeAimFrom(bot, crystal, new Vec3(3.5, 82.62, 3.5)), "a diagonal top-layer eye still reaches");
  assert.equal(crystalMeleeAimFrom(bot, crystal, new Vec3(4.5, 82.62, 1.5)), null, "four blocks out on an axis does not");
});

test("the melee return accepts any supported cell near the start instead of one exact block", () => {
  const goal = crystalReturnGoal(new Vec3(10.4, 64, -3.6)).resolve(observation());
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") return;
  const satisfied = (x: number, y: number, z: number) => goal.isSatisfied(planningStart(new Vec3(x, y, z)).node, new MemoryWorld());
  assert.equal(satisfied(10, 64, -4), true);
  assert.equal(satisfied(13, 65, -2), true, "a lower tread beside the start is off the tower");
  assert.equal(satisfied(14, 64, -4), true);
  assert.equal(satisfied(15, 64, -4), false, "five blocks out is not near");
  assert.equal(satisfied(10, 67, -4), false, "three treads up is still on the staircase");
  assert.equal(satisfied(10, 60, -4), false, "a pit below the island is not the ground");
});
