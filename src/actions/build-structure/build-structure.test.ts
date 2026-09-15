import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { structureWorld } from "../../test-support/structure-world.js";
import { parseBuildStructureRequest, portalFrameCells, type StructureCell } from "./contract.js";
import { formatBuildStructureResult, buildStructure } from "./build-structure.js";

function cells(list: [number, number, number][], blockName = "cobblestone"): StructureCell[] {
  return list.map(([x, y, z]) => ({ x, y, z, blockName }));
}

test("the portal preset uses ten obsidian, four corner supports and six interior air cells, and conflicting cells are refused", () => {
  const frame = portalFrameCells({ x: 5, y: 64, z: 0, axis: "x", corner_block: "cobblestone" });
  assert.equal(frame.length, 20);
  assert.equal(frame.filter((cell) => cell.blockName === "obsidian").length, 10);
  assert.equal(frame.filter((cell) => cell.blockName === "cobblestone").length, 4);
  const interior = frame.filter((cell) => cell.blockName === "air");
  assert.equal(interior.length, 6);
  assert.ok(interior.every((cell) => (cell.x === 5 || cell.x === 6) && cell.y >= 64 && cell.y <= 66 && cell.z === 0));
  assert.ok(
    frame.some((cell) => cell.x === 4 && cell.y === 63 && cell.z === 0 && cell.blockName === "cobblestone"),
    "bottom-left corner",
  );
  assert.ok(
    frame.some((cell) => cell.x === 7 && cell.y === 67 && cell.z === 0 && cell.blockName === "cobblestone"),
    "top-right corner",
  );
  assert.ok(
    !frame.some((cell) => cell.x === 5 && cell.y === 64 && cell.blockName === "obsidian"),
    "the interior is not frame",
  );

  const parsed = parseBuildStructureRequest({ portal_frame: { x: 5, y: 64, z: 0 } });
  assert.equal(parsed.cells.length, 20);
  assert.deepEqual(parsed.cells, frame);
  const rotated = parseBuildStructureRequest({
    portal_frame: { x: 0, y: 64, z: 5, axis: "z", corner_block: "dirt" },
  });
  assert.deepEqual(
    rotated.cells,
    frame.map((cell) => ({
      ...cell,
      x: cell.z,
      z: cell.x,
      blockName: cell.blockName === "cobblestone" ? "dirt" : cell.blockName,
    })),
  );
  assert.throws(
    () =>
      parseBuildStructureRequest({
        blocks: [
          { x: 1, y: 64, z: 1, block_name: "stone" },
          { x: 1, y: 64, z: 1, block_name: "dirt" },
        ],
      }),
    /both stone and dirt/,
  );
  assert.throws(() => parseBuildStructureRequest({}), /needs blocks/);
});

test("a finished structure is reported complete with what was placed", async () => {
  const { bot, physics } = structureWorld();
  const result = await buildStructure(
    bot,
    {
      cells: cells([
        [2, 64, 0],
        [3, 64, 0],
      ]),
      removeWrongBlocks: false,
    },
    {},
    physics,
  );
  assert.equal(result.status, "succeeded");
  assert.ok(result.structure);
  assert.equal(result.structure.placed, 2);
  assert.deepEqual(result.structure.left, []);
  assert.match(formatBuildStructureResult(result), /Every cell of the structure holds its block \(2 cells\)/);
});

test("the audit says why each wrong cell was left, naming the block in the way and the shortfall", async () => {
  const { bot, put, physics } = structureWorld({ carried: { cobblestone: 1 } });
  put(new Vec3(2, 64, 0), "oak_leaves");
  const result = await buildStructure(
    bot,
    {
      cells: cells([
        [2, 64, 0],
        [3, 64, 0],
        [4, 64, 0],
      ]),
      removeWrongBlocks: false,
    },
    {},
    physics,
  );
  if (result.status === "succeeded") assert.fail("leaves are not cobblestone and one block cannot fill two cells");
  assert.ok(result.structure);
  assert.equal(result.structure.placed, 1);
  assert.equal(result.structure.wrong, 2);
  assert.deepEqual(result.structure.left, [
    { reason: "holds_another_block", count: 1, named: [{ x: 2, y: 64, z: 0, holds: "oak_leaves" }] },
    { reason: "block_not_carried", count: 1, named: [{ x: 4, y: 64, z: 0 }] },
  ]);
  assert.deepEqual(result.structure.missing, [{ block: "cobblestone", count: 2 }]);
  assert.match(
    result.error,
    /BUILD_INCOMPLETE\] 2 cells still wrong: 1 hold another block \(oak_leaves at 2,64,0\); 1 need a block the bot does not carry \(4,64,0\); short of 2 cobblestone\./,
  );
  const markdown = formatBuildStructureResult(result);
  assert.match(markdown, /- Left wrong: 1 hold another block \(oak_leaves at 2,64,0\)/);
  assert.match(markdown, /- Missing: 2 cobblestone/);
});

test("a block Minecraft does not have is refused before anything moves", async () => {
  const { bot, physics, placements } = structureWorld();
  const result = await buildStructure(
    bot,
    { cells: cells([[2, 64, 0]], "unobtainium"), removeWrongBlocks: false },
    {},
    physics,
  );
  assert.equal(result.status, "failed");
  assert.match((result as { error: string }).error, /no block named unobtainium/);
  assert.deepEqual(placements, []);
  assert.equal(result.structure, null);
  assert.doesNotMatch(formatBuildStructureResult(result), /Every cell/);
});
