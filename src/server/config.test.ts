import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DATA_ROOT, parseHostOptions } from "./config.js";

test("defaults to persistent personal bot data, and to no unrestricted JavaScript execution", () => {
  const options = parseHostOptions([]);

  assert.deepEqual(options.botData, {
    storage: {
      kind: "persistent",
      root: path.resolve(DEFAULT_DATA_ROOT),
    },
    scope: "bot",
  });
  assert.equal(options.debugExecuteJavaScript, false);
  // Debug execution is reachable only through its own explicit flag.
  assert.equal(parseHostOptions(["--debug-execute-javascript"]).debugExecuteJavaScript, true);
});

test("temporary bot data has no meaningless persistent root", () => {
  const options = parseHostOptions([
    "--bot-data-persistence",
    "temporary",
    "--data-root",
    "ignored-for-temporary-data",
  ]);

  assert.deepEqual(options.botData, {
    storage: { kind: "temporary" },
    scope: "bot",
  });
});

test("rejects unknown bot-data choices at the host boundary", () => {
  assert.throws(
    () => parseHostOptions(["--bot-data-persistence", "sometimes"]),
    /--bot-data-persistence must be one of persistent, temporary/,
  );
  assert.throws(
    () => parseHostOptions(["--bot-data-scope", "team"]),
    /--bot-data-scope must be one of bot, shared/,
  );
});
