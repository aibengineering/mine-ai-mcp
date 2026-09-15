import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceImports } from "../../test-support/imports.js";

const survival = fileURLToPath(new URL("../", import.meta.url));

test("survival policy selects from facts without importing the bot, mutable stores or physical execution", () => {
  const invalid = sourceImports(survival, "policy").filter(({ target, typeOnly }) => {
    if (target === "mineflayer") return true;
    if (typeOnly) return false;
    // Food's fixed regeneration threshold is shared game data; decisions receive no live bot.
    return !(
      target.startsWith("policy/") ||
      target === "../world/food.js" ||
      target === "zod" ||
      target === "node:util"
    );
  });
  assert.deepEqual(invalid, []);
});

test("survival observations cannot import execution, body ownership or the live policy store", () => {
  const invalid = sourceImports(survival, "perception").filter(
    ({ target, typeOnly }) =>
      !typeOnly &&
      (target.startsWith("responses/") ||
        target.startsWith("reflexes/") ||
        target.startsWith("baseline/") ||
        target.startsWith("guards/") ||
        target.startsWith("control/") ||
        target.startsWith("../session/") ||
        target.startsWith("../actions/") ||
        target === "state/survival-policy.js"),
  );
  assert.deepEqual(invalid, []);
});

test("physical responses cannot register reflexes or own an idle baseline", () => {
  const invalid = sourceImports(survival, "responses").filter(
    ({ target, typeOnly }) =>
      !typeOnly &&
      (target.startsWith("reflexes/") ||
        target.startsWith("baseline/") ||
        target.startsWith("guards/") ||
        target === "control/driver.js" ||
        target === "../session/action-runner.js"),
  );
  assert.deepEqual(invalid, [], "Runtime attaches lifetimes; physical responses execute under the admitted signal.");
});
