import minecraftData from "minecraft-data";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { selectCombatLoadout } from "./equipment.js";

const registry = minecraftData("1.21.4");
// The package exports a CommonJS loader; its default declaration is not callable under NodeNext.
const loadItem = createRequire(import.meta.url)("prismarine-item") as typeof import("prismarine-item").default;
const Item = loadItem(registry);
const item = (name: string) => new Item(registry.itemsByName[name]!.id, 1);

test("melee falls back to the best carried tool family, including when a bow is unloaded", () => {
  const axe = item("iron_axe");
  assert.deepEqual(selectCombatLoadout([item("diamond_shovel"), item("wooden_pickaxe"), axe], { x: 2, y: 0, z: 0 }), {
    kind: "melee",
    weapon: axe,
    shield: null,
    cooldownTicks: 25,
  });
  const stoneAxe = item("stone_axe");
  assert.deepEqual(selectCombatLoadout([item("bow"), stoneAxe], { x: 10, y: 0, z: 0 }), {
    kind: "melee",
    weapon: stoneAxe,
    shield: null,
    cooldownTicks: 25,
  });
});

test("a usable bow yields to melee at the six-block boundary", () => {
  const bow = item("bow");
  const sword = item("iron_sword");
  const shield = item("shield");
  const carried = [bow, item("arrow"), sword, shield];

  assert.deepEqual(selectCombatLoadout(carried, { x: 6, y: 0, z: 0 }), {
    kind: "melee",
    weapon: sword,
    shield,
    cooldownTicks: 13,
  });
  assert.deepEqual(selectCombatLoadout(carried, { x: 6.01, y: 0, z: 0 }), { kind: "bow", weapon: bow, shield });
});

test("each supported arrow makes a bow usable; an unloaded bow falls back to an empty hand", () => {
  const bow = item("bow");
  for (const arrow of ["arrow", "spectral_arrow", "tipped_arrow"]) {
    assert.deepEqual(selectCombatLoadout([bow, item(arrow)], { x: 10, y: 0, z: 0 }), {
      kind: "bow",
      weapon: bow,
      shield: null,
    });
  }
  assert.deepEqual(selectCombatLoadout([bow], { x: 10, y: 0, z: 0 }), {
    kind: "melee",
    weapon: null,
    shield: null,
    cooldownTicks: 5,
  });
});

test("a nearby target above melee height uses the carried bow without changing ground melee selection", () => {
  const bow = item("bow");
  const sword = item("iron_sword");
  const carried = [bow, sword, item("arrow")];
  assert.equal(selectCombatLoadout(carried, { x: 3, y: 4, z: 0 }).kind, "bow");
  assert.equal(selectCombatLoadout(carried, { x: 3, y: 3, z: 0 }).kind, "melee");
  assert.equal(selectCombatLoadout(carried, { x: 5, y: 0, z: 0 }).kind, "melee");
  assert.equal(selectCombatLoadout([bow, sword], { x: 3, y: 4, z: 0 }).kind, "melee");
});
