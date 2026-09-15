import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FOOD_POLICY } from "./contract.js";
import { rawFoodPermitted } from "./food.js";

const rule = DEFAULT_FOOD_POLICY.raw;

test("by default uncooked food waits for the sprint floor or a wounded bot that cannot regenerate", () => {
  assert.equal(rawFoodPermitted(rule, { health: 20, hunger: 14 }).permitted, false, "ordinary hunger keeps it for cooking");
  assert.equal(rawFoodPermitted(rule, { health: 20, hunger: 7 }).permitted, false, "sprinting still works at seven");
  assert.equal(rawFoodPermitted(rule, { health: 20, hunger: 6 }).permitted, true, "sprinting stops at six");
  assert.equal(rawFoodPermitted(rule, { health: 12, hunger: 14 }).permitted, false, "above half health it waits");
  assert.equal(rawFoodPermitted(rule, { health: 9, hunger: 14 }).permitted, true, "below half health it heals");
  assert.equal(
    rawFoodPermitted(rule, { health: 9, hunger: 18 }).permitted,
    false,
    "at regeneration hunger the wound heals without spending the meat",
  );
  assert.match(rawFoodPermitted(rule, { health: 20, hunger: 14 }).reason, /at most 6.*below 10/);
});

test("the model can move the floors or switch the rule off in either direction", () => {
  assert.equal(rawFoodPermitted({ ...rule, hunger_at_most: 10 }, { health: 20, hunger: 10 }).permitted, true);
  assert.equal(rawFoodPermitted({ ...rule, health_below: 16 }, { health: 15, hunger: 14 }).permitted, true);
  assert.equal(rawFoodPermitted({ ...rule, allow: "always" }, { health: 20, hunger: 20 }).permitted, true);
  assert.equal(rawFoodPermitted({ ...rule, allow: "never" }, { health: 1, hunger: 0 }).permitted, false);
});
