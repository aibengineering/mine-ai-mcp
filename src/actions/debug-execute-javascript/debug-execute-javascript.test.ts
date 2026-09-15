import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { parseDebugExecuteJavaScriptRequest } from "./contract.js";
import { executeDebugJavaScript, formatDebugExecuteJavaScriptResult } from "./debug-execute-javascript.js";

test("executes awaited code with the live bot, Vec3, and captured console in scope", async () => {
  // One function body and nothing else: no timeout, no empty program.
  assert.deepEqual(parseDebugExecuteJavaScriptRequest({ code: "return bot.username" }), {
    code: "return bot.username",
  });
  assert.throws(() => parseDebugExecuteJavaScriptRequest({ code: "return 1", timeout: 10 }));
  assert.throws(() => parseDebugExecuteJavaScriptRequest({ code: "   " }));

  const bot = botFixture({ blocks: { "1,60,0": "spruce_log" }, position: new Vec3(0.5, 60, 0.5) });
  const result = await executeDebugJavaScript(bot, {
    code: [
      "const target = bot.blockAt(new Vec3(1, 60, 0));",
      "await Promise.resolve();",
      "console.log('target', target.name, target.position);",
      "return { name: target.name, distance: bot.entity.position.distanceTo(target.position) };",
    ].join("\n"),
  });

  assert.equal(result.status, "succeeded");
  assert.match(result.execution.value, /name: 'spruce_log'/);
  assert.match(result.execution.value, /distance:/);
  assert.match(result.execution.logs[0] ?? "", /target spruce_log Vec3/);
  const markdown = formatDebugExecuteJavaScriptResult(result);
  assert.match(markdown, /### Return value/);
  assert.match(markdown, /### Console/);
  assert.match(markdown, /target spruce_log Vec3/);
});

test("returns the debug stack and prior console output when the program throws", async () => {
  const result = await executeDebugJavaScript(botFixture({ position: new Vec3(0.5, 60, 0.5) }), {
    code: "console.warn('before failure'); throw new Error('diagnostic boom');",
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.match(result.error, /diagnostic boom/);
    assert.match(result.error, /debug_execute_javascript\.mcp\.js/);
    assert.deepEqual(result.execution.logs, ["[warn] before failure"]);
  }
});
