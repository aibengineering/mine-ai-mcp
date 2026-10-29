import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findLoadedBlockPositions, findLoadedBlocksByName, type LoadedBlockScan } from "./loaded-block-scan.js";

interface TestSection {
  solidBlockCount: number;
  data: { value?: number };
  palette?: number[];
  get(position: { x: number; y: number; z: number }): number;
}

interface TestColumn {
  chunkX: number;
  chunkZ: number;
  column: { minY: number; sections: (TestSection | undefined)[] };
}

function scannerBot(columns: TestColumn[]): Bot {
  return {
    world: { getColumns: () => columns },
    blockAt: () => {
      throw new Error("the raw scanner must not construct Prismarine blocks");
    },
  } as unknown as Bot;
}

/**
 * One chunk-aligned section whose packed reads answer from `matching`, counting
 * every read so a test can assert what the scan cost.
 */
function countedColumn(minY: number, palette: number[], matching: Record<string, number>) {
  const reads = { count: 0 };
  const section: TestSection = {
    solidBlockCount: 4_096,
    data: {},
    palette,
    get(position) {
      reads.count += 1;
      return matching[`${position.x},${position.y},${position.z}`] ?? 0;
    },
  };
  return { reads, columns: [{ chunkX: 0, chunkZ: 0, column: { minY, sections: [section] } }] };
}

/**
 * The scan's three cost rules in one shape: only cells inside the horizontal
 * radius are read, the whole vertical column is, and a palette that cannot
 * hold a wanted state is never unpacked at all.
 */
const packedScans = [
  {
    name: "reports the nearest match in world coordinates and never reads outside the radius",
    minY: 64,
    palette: [0, 7],
    matching: { "1,0,0": 7, "3,0,0": 7 },
    radius: 2,
    expected: [[1, 64, 0]],
    // Six horizontal cells in radius, at all sixteen heights.
    reads: 96,
  },
  {
    name: "searches the full vertical column inside that horizontal radius",
    minY: -64,
    palette: [0, 7],
    matching: { "1,10,1": 7, "3,0,0": 7 },
    radius: 2,
    expected: [[1, -54, 1]],
    reads: 96,
  },
  {
    name: "skips a section whose palette cannot match, however wide the request",
    minY: 64,
    palette: [0, 1],
    matching: { "1,0,0": 7 },
    radius: 64,
    expected: [],
    reads: 0,
  },
] as const;

for (const scan of packedScans) {
  test(`loaded block scanning ${scan.name}`, () => {
    const { reads, columns } = countedColumn(scan.minY, [...scan.palette], { ...scan.matching });

    const positions = findLoadedBlockPositions(scannerBot(columns), {
      center: { x: 0, y: 64, z: 0 },
      radius: scan.radius,
      stateIds: new Set([7]),
      limit: 64,
    });

    assert.deepEqual(
      positions.map((position) => [position.x, position.y, position.z]),
      scan.expected.map((cell) => [...cell]),
    );
    assert.equal(reads.count, scan.reads, "packed reads");
  });
}

/** Deliberately exhaustive: no palette, spatial pruning, or bounded selection. */
function referenceScan(columns: TestColumn[], scan: LoadedBlockScan): Vec3[] {
  const center = new Vec3(scan.center.x, scan.center.y, scan.center.z).floored();
  const matches: Vec3[] = [];
  for (const { chunkX, chunkZ, column } of columns) {
    for (let index = 0; index < column.sections.length; index++) {
      const section = column.sections[index];
      if (!section || section.solidBlockCount === 0) continue;
      for (let y = 0; y < 16; y++) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if (!scan.stateIds.has(section.get({ x, y, z }))) continue;
            const position = new Vec3(chunkX * 16 + x, column.minY + index * 16 + y, chunkZ * 16 + z);
            if (
              scan.radius !== undefined &&
              (position.x - center.x) ** 2 + (position.z - center.z) ** 2 > scan.radius ** 2
            )
              continue;
            matches.push(position);
          }
        }
      }
    }
  }
  return matches.sort((a, b) => a.distanceSquared(center) - b.distanceSquared(center)).slice(0, scan.limit);
}

for (const density of ["dense", "sparse", "mixed"] as const) {
  test(`bounded scan equals exhaustive results for ${density} sections, including distance ties`, () => {
    const columns: TestColumn[] = [];
    let random = 17;
    for (const chunkX of [1, -1, 0]) {
      for (const chunkZ of [1, -1, 0]) {
        const sections: TestSection[] = [];
        for (let index = 0; index < 3; index++) {
          const states = Array.from({ length: 4096 }, () => {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            return density === "dense" ? 7 : random % (density === "sparse" ? 4096 : 3) === 0 ? 7 : 1;
          });
          sections.push({
            solidBlockCount: 4096,
            data: density === "dense" ? { value: 7 } : {},
            // Exercise both indirect palettes and direct containers without a palette.
            ...(index === 0 && density !== "dense" ? { palette: [1, 7] } : {}),
            get: ({ x, y, z }) => states[y * 256 + z * 16 + x]!,
          });
        }
        columns.push({ chunkX, chunkZ, column: { minY: -64, sections } });
      }
    }
    for (const center of [new Vec3(-0.2, -48.1, 15.9), new Vec3(16, 20, 16)]) {
      for (const radius of [undefined, 0, 2, 17]) {
        const request = { center, stateIds: new Set([7]), ...(radius === undefined ? {} : { radius }) };
        const exhaustive = referenceScan(columns, { ...request, limit: Infinity });
        for (const limit of [0, 1, 16, 256, Infinity]) {
          assert.deepEqual(
            findLoadedBlockPositions(scannerBot(columns), { ...request, limit }),
            exhaustive.slice(0, limit),
            JSON.stringify({ density, center, radius, limit }),
          );
        }
      }
    }
  });
}

test("single-value sections need no packed reads and distant sections stop once nearest candidates are known", () => {
  const neverRead = () => {
    throw new Error("this section must not be read");
  };
  const columns: TestColumn[] = [
    { chunkX: 100, chunkZ: 100, column: { minY: 64, sections: [{ solidBlockCount: 4096, data: {}, get: neverRead }] } },
    {
      chunkX: 0,
      chunkZ: 0,
      column: {
        minY: 64,
        sections: [
          { solidBlockCount: 4096, data: { value: 7 }, get: neverRead },
          { solidBlockCount: 4096, data: { value: 1 }, get: neverRead },
        ],
      },
    },
  ];
  const positions = findLoadedBlockPositions(scannerBot(columns), {
    center: new Vec3(8, 72, 8),
    stateIds: new Set([7]),
    limit: 256,
  });
  assert.equal(positions.length, 256);
  assert.deepEqual(positions[0], new Vec3(8, 72, 8));
});

/** Nine chunk columns carrying three block states each, with and without palettes. */
function mixedColumns(): TestColumn[] {
  const columns: TestColumn[] = [];
  let random = 41;
  for (const chunkX of [1, -1, 0]) {
    for (const chunkZ of [1, -1, 0]) {
      const sections: TestSection[] = [];
      for (let index = 0; index < 3; index += 1) {
        const states = Array.from({ length: 4_096 }, () => {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          return random % 3 === 0 ? 7 : random % 7 === 0 ? 5 : 1;
        });
        sections.push({
          solidBlockCount: 4_096,
          data: {},
          ...(index === 1 ? { palette: [1, 5, 7] } : {}),
          get: ({ x, y, z }) => states[y * 256 + z * 16 + x]!,
        });
      }
      columns.push({ chunkX, chunkZ, column: { minY: -64, sections } });
    }
  }
  return columns;
}

const namedScanCases = [
  { center: { x: 0, y: -48, z: 0 }, radius: undefined },
  { center: { x: 8, y: -48, z: 9 }, radius: 0 },
  { center: { x: -8, y: 12, z: 30 }, radius: 17 },
  { center: { x: 16, y: 20, z: 16 }, radius: 2 },
] as const;

test("the named scan reports exactly what scans per kind would have", async () => {
  const columns = mixedColumns();
  const wanted = [
    { name: "seven", stateIds: new Set([7]) },
    { name: "one", stateIds: new Set([1]) },
    { name: "both kinds", stateIds: new Set([1, 7]) },
  ];
  for (const { center, radius } of namedScanCases) {
    const base = { center, ...(radius === undefined ? {} : { radius }) };
    for (const limit of [1, 24, 256]) {
      const reported = await findLoadedBlocksByName(scannerBot(columns), { ...base, limit, names: wanted });
      for (const [index, { name, stateIds }] of wanted.entries()) {
        assert.deepEqual(
          reported[index]!.positions.map((position) => [position.x, position.y, position.z]),
          findLoadedBlockPositions(scannerBot(columns), { ...base, stateIds, limit }).map((p) => [p.x, p.y, p.z]),
          JSON.stringify({ name, center, radius, limit }),
        );
        assert.equal(
          reported[index]!.name,
          name,
          "names come back in the order asked, one entry each",
        );
        assert.equal(
          reported[index]!.found,
          findLoadedBlockPositions(scannerBot(columns), {
            ...base,
            stateIds,
            limit: Number.POSITIVE_INFINITY,
          }).length,
          JSON.stringify({ name, center, radius }),
        );
      }
    }
  }
});

test("a named scan hands the event loop back while it counts the loaded world", { timeout: 60_000 }, async () => {
  const neverRead = () => {
    throw new Error("single-value sections answer without packed reads");
  };
  const columns: TestColumn[] = Array.from({ length: 8_000 }, (_unused, chunkX) => ({
    chunkX,
    chunkZ: 0,
    column: { minY: 0, sections: [{ solidBlockCount: 4_096, data: { value: 7 }, get: neverRead }] },
  }));
  let heartbeats = 0;
  const beat = (async () => {
    while (heartbeats < 20) {
      await new Promise((resolve) => setImmediate(resolve));
      heartbeats += 1;
    }
  })();
  const reported = await findLoadedBlocksByName(scannerBot(columns), {
    center: { x: 0, y: 0, z: 0 },
    limit: 64,
    names: [{ name: "seven", stateIds: new Set([7]) }],
  });
  await beat;
  assert.ok(heartbeats >= 20, "a scan this wide must let the event loop run while it reads");
  assert.equal(reported[0]!.found, 8_000 * 4_096, "counts stay whole while lists stay bounded");
  assert.equal(reported[0]!.positions.length, 64);
});

test("a named scan with nothing wanted or no limit to fill reads nothing", async () => {
  const scanner = scannerBot([]);
  assert.deepEqual(
    await findLoadedBlocksByName(scanner, { center: { x: 0, y: 0, z: 0 }, limit: 12, names: [] }),
    [],
  );
  assert.deepEqual(
    await findLoadedBlocksByName(scanner, {
      center: { x: 0, y: 0, z: 0 },
      limit: 0,
      names: [{ name: "seven", stateIds: new Set([7]) }],
    }),
    [{ name: "seven", found: 0, positions: [] }],
  );
});

test("sparse scans retain distant matches and observe single-value container replacement", () => {
  const section: TestSection = { solidBlockCount: 4096, data: { value: 1 }, get: () => 1 };
  const columns: TestColumn[] = [{ chunkX: 100, chunkZ: -100, column: { minY: -64, sections: [undefined, section] } }];
  const request = { center: new Vec3(0, 64, 0), stateIds: new Set([7]), limit: 256 };
  const bot = scannerBot(columns);
  assert.deepEqual(findLoadedBlockPositions(bot, request), []);
  section.data = {};
  section.palette = [1, 7];
  section.get = ({ x, y, z }) => (x === 2 && y === 3 && z === 4 ? 7 : 1);
  assert.deepEqual(findLoadedBlockPositions(bot, request), [new Vec3(1602, -45, -1596)]);
  assert.deepEqual(findLoadedBlockPositions(bot, { ...request, stateIds: new Set() }), []);
});
