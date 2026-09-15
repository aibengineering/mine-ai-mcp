import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { DEFAULT_FOOD_POLICY } from "../policy/contract.js";
import { selectPolicyFood } from "./food.js";

const registry = minecraftData("1.21.4");

function fed(health: number, food: number, carried: { name: string; count: number }[]): Bot {
  return { health, food, registry, inventory: { items: () => carried } } as unknown as Bot;
}

test("a hunt's raw drops are held back at ordinary hunger and named as withheld", () => {
  const selection = selectPolicyFood(fed(20, 12, [{ name: "beef", count: 4 }]), DEFAULT_FOOD_POLICY);
  assert.equal(selection.food, null);
  assert.equal(selection.withheld?.name, "beef");
  assert.equal(selection.verdict.permitted, false);
});

test("cooked food is eaten as before, and nothing is reported withheld when a meal exists", () => {
  const selection = selectPolicyFood(
    fed(20, 12, [
      { name: "beef", count: 4 },
      { name: "bread", count: 1 },
    ]),
    DEFAULT_FOOD_POLICY,
  );
  assert.equal(selection.food?.name, "bread");
  assert.equal(selection.withheld, null);
});

test("below the sprint floor or half health the raw drops become the meal", () => {
  assert.equal(selectPolicyFood(fed(20, 6, [{ name: "beef", count: 4 }]), DEFAULT_FOOD_POLICY).food?.name, "beef");
  assert.equal(selectPolicyFood(fed(8, 14, [{ name: "beef", count: 4 }]), DEFAULT_FOOD_POLICY).food?.name, "beef");
});

test("raw chicken stays off the menu even in an emergency; its hunger effect is the model's call", () => {
  const selection = selectPolicyFood(fed(4, 2, [{ name: "chicken", count: 2 }]), DEFAULT_FOOD_POLICY);
  assert.equal(selection.food, null);
  assert.equal(selection.withheld, null);
});
