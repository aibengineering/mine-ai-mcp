import assert from "node:assert/strict";
import test from "node:test";
import {
  PREPARE_DRAGON_PERCH_DESCRIPTION,
  prepareDragonPerchCheckpointSchema,
  prepareDragonPerchInputSchema,
} from "./contract.js";

test("preparation accepts one observed dragon and publishes actionable staging progress", () => {
  assert.deepEqual(prepareDragonPerchInputSchema.parse({ entity_id: 17 }), {
    entity_id: 17,
  });
  assert.deepEqual(
    prepareDragonPerchCheckpointSchema.parse({
      preparedPosition: { x: 0.5, y: 61, z: -2.5 },
      stage: "ready",
      blockedBy: null,
    }),
    {
      preparedPosition: { x: 0.5, y: 61, z: -2.5 },
      stage: "ready",
      blockedBy: null,
    },
  );
  assert.throws(
    () => prepareDragonPerchInputSchema.parse({ entity_id: 17, attack: true }),
    /Unrecognized key/,
  );
  assert.match(PREPARE_DRAGON_PERCH_DESCRIPTION, /without swinging/);
});
