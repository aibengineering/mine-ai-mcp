import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import { writeScenarioEvidence } from "./scenario-evidence.ts";

test("driver evidence preserves a large trace in separate per-bot files and reports write failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scenario-evidence-"));
  const original = process.env.MINE_LABS_ARTIFACTS_DIR;
  const context = (username: string) => ({ bot: { username } }) as MineAiScenarioContext;
  try {
    process.env.MINE_LABS_ARTIFACTS_DIR = root;
    const evidence = { samples: [{ detail: "x".repeat(1_100_000) }] };
    const first = await writeScenarioEvidence(context("FirstBot"), "trace.json", evidence);
    const second = await writeScenarioEvidence(context("SecondBot"), "trace.json", { samples: [] });
    assert.notEqual(first, second);
    assert.equal(first, path.join(root, "FirstBot", "trace.json"));
    assert.deepEqual(JSON.parse(await readFile(first, "utf8")), evidence);
    assert.deepEqual(JSON.parse(await readFile(second, "utf8")), { samples: [] });
    // A failed artifact write must not produce a success receipt pointing at missing evidence.
    process.env.MINE_LABS_ARTIFACTS_DIR = first;
    await assert.rejects(writeScenarioEvidence(context("FirstBot"), "trace.json", evidence));
    delete process.env.MINE_LABS_ARTIFACTS_DIR;
    await assert.rejects(writeScenarioEvidence(context("FirstBot"), "trace.json", evidence), /artifacts directory/);
  } finally {
    if (original === undefined) delete process.env.MINE_LABS_ARTIFACTS_DIR;
    else process.env.MINE_LABS_ARTIFACTS_DIR = original;
    await rm(root, { recursive: true, force: true });
  }
});
