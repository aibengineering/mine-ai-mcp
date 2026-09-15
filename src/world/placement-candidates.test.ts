import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findFlatPlacementCandidates } from "./placement-candidates.js";

test("finds supported flat footprints without placing through the player", () => {
  const bot = {
    entity: { position: new Vec3(0.8, 64, 0.5) },
    blockAt: (position: Vec3) => ({
      name: position.y === 63 ? "stone" : "air",
      boundingBox: position.y === 63 ? "block" : "empty",
    }),
  } as Bot;

  const candidates = findFlatPlacementCandidates(bot, [new Vec3(0, 0, 0), new Vec3(1, 0, 0)], 1);

  assert.ok(candidates.length > 0);
  assert.equal(
    candidates.some((origin) => origin.equals(new Vec3(1, 64, 0))),
    false,
  );
  assert.equal(
    candidates.every((origin) => origin.y === 64),
    true,
  );
});
