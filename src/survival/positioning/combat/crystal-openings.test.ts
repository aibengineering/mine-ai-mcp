import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../../navigation/world/memory-world.js";
import { findCrystalOpenings } from "./crystal-openings.js";

function searchFixture() {
  const world = new MemoryWorld();
  // Native caged-crystal incident: most standing cells have no firing slit.
  // A sparse opening must survive the search, even after it yields.
  for (const [x, z] of [[0, 0], [16, 0], [31, 15]]) {
    world.load({ x, y: 57, z }, { stateId: 1 });
    world.load({ x, y: 58, z }, { stateId: 0 });
    world.load({ x, y: 59, z }, { stateId: 0 });
  }
  return { world, columns: [{ chunkX: 0, chunkZ: 0 }, { chunkX: 1, chunkZ: 0 }],
    origin: new Vec3(.5, 58, .5), target: new Vec3(12.5, 80, 39.5), receiptRange: 64,
    signal: new AbortController().signal, interrupted: () => false };
}

test("a sparse crystal firing scan yields to the event loop and retains a distant opening", async () => {
  let heartbeat = false;
  setImmediate(() => { heartbeat = true; });
  const cells = await findCrystalOpenings({ ...searchFixture(),
    canShoot: feet => feet.x === 31.5 && feet.z === 15.5 });
  assert.equal(heartbeat, true, "the watchdog and Minecraft packets must run during the scan");
  assert.deepEqual(cells?.map(cell => cell.toArray()), [[31, 58, 15]]);
});

for (const interruption of ["cancelled", "danger appeared"] as const) {
  test(`crystal firing search stops when ${interruption} during a yield`, async () => {
    const caller = new AbortController();
    let danger = false, shotsChecked = 0, checkedAtHandoff = 0;
    setImmediate(() => {
      checkedAtHandoff = shotsChecked;
      if (interruption === "cancelled") caller.abort(new Error("caller cancelled"));
      else danger = true;
    });
    const scan = findCrystalOpenings({ ...searchFixture(), signal: caller.signal,
      interrupted: () => danger, canShoot: () => { shotsChecked++; return false; } });
    if (interruption === "cancelled") await assert.rejects(scan, /caller cancelled/);
    else assert.equal(await scan, null);
    assert.equal(shotsChecked, checkedAtHandoff, "stop checking shots after the handoff");
    assert.ok(shotsChecked < 3, "the interruption must arrive before scanning all candidate sites");
  });
}
