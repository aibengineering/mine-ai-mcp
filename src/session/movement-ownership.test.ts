import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("movement inputs belong to navigation, survival, and the bounded raw action", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const invalid: { file: string; call: string }[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const file = entry.replaceAll("\\", "/");
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("test-support/")) continue;
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const call = node.expression.name.text;
        if (["setControlState", "clearControlStates"].includes(call)) {
          const ownsMovement = file.startsWith("navigation/") || file.startsWith("survival/");
          const preparesBody = file.startsWith("session/") && call === "clearControlStates";
          const rawBodyAction = file === "actions/raw-action/raw-action.ts" && call === "setControlState";
          if (!ownsMovement && !preparesBody && !rawBodyAction) invalid.push({ file, call });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(
    invalid,
    [],
    "Only the explicit bounded raw action may drive controls outside navigation and survival.",
  );
});
