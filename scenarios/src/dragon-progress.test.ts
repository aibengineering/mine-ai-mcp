import assert from "node:assert/strict";
import test from "node:test";
import { DragonDamageProgress } from "./dragon-progress.ts";

test("real damage extends the scenario but healing and missing observations do not", () => {
  const progress = new DragonDamageProgress(200, 0, 180_000);
  assert.equal(progress.observe(150, 170_000), "progressing");
  assert.equal(progress.observe(180, 300_000), "progressing");
  assert.equal(progress.observe(150, 349_999), "progressing");
  assert.equal(progress.observe(null, 350_000), "stalled");
  assert.equal(progress.lowestHealth, 150);
});

test("no first damage reaches the deadline, while an observed kill permits portal settlement", () => {
  assert.equal(new DragonDamageProgress(200, 0, 180_000).observe(200, 180_000), "stalled");
  const killed = new DragonDamageProgress(24, 0, 180_000);
  assert.equal(killed.observe(0, 10_000), "progressing");
  assert.equal(killed.observe(null, 200_000), "progressing");
});
