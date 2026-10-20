import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadScenario } from "mine-labs";
import { describeActionTools } from "../src/actions/describe.ts";
import { catalogueGaps, evidenceParamsSchema } from "../tools/action-evidence/capture.ts";

const tour = fileURLToPath(new URL("../tools/action-evidence/action-catalog.yaml", import.meta.url));

/**
 * The evidence page documents every published tool from one real call each.
 * The capture refuses an incomplete tour, but only when someone runs it against
 * Minecraft: shoot_dragon and prepare_dragon_perch were published on
 * 2026-09-15 (b0b0178 in the pre-release history) two days after the tour's
 * step list was last edited, and the page silently lacked them until the
 * 2026-10-19 catalogue run reported it. This reads the same catalogue the MCP
 * host publishes, without a server.
 */
test("the evidence tour calls every published tool exactly once", async () => {
  const published = describeActionTools().filter((tool) => !tool.debugOnly).map((tool) => tool.name);
  const { steps } = evidenceParamsSchema.parse((await loadScenario(tour)).params);
  assert.deepEqual(catalogueGaps(published, steps), []);
});

test("an incomplete, repeated or unknown step is reported", () => {
  const steps = [{ action: "view_status" }, { action: "view_status" }, { action: "fly" }];
  assert.deepEqual(catalogueGaps(["view_status", "navigate", "wait_for_action"], steps), [
    "duplicate steps: view_status",
    "missing published tools: navigate",
    "unknown tools: fly",
  ]);
});
