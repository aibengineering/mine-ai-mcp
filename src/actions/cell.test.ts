import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { wholeCell } from "./cell.js";

const schema = z
  .strictObject({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() })
  .superRefine(wholeCell("all or none"));

test("a target cell is all three coordinates or none, refused as a zod issue", () => {
  for (const cell of [{}, { x: 1, y: 2, z: 3 }]) assert.ok(schema.safeParse(cell).success, JSON.stringify(cell));
  for (const cell of [{ x: 1 }, { x: 1, y: 2 }, { y: 2, z: 3 }, { z: 3 }]) {
    const parsed = schema.safeParse(cell);
    assert.equal(parsed.success, false, JSON.stringify(cell));
    assert.equal(parsed.error?.issues[0]?.message, "all or none");
  }
});
