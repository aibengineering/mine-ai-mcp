import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { layerViolations, type Layers } from "./test-support/imports.js";

// Each module's folders, top layer first. Shared vocabulary lives at the bottom
// of whatever imports it, so every import reads down the page.
const src = fileURLToPath(new URL(".", import.meta.url));
const module = (name: string) => fileURLToPath(new URL(`./${name}/`, import.meta.url));

const SRC: Layers = [
  ["server", "index.ts", "bot-capabilities.ts"],
  ["runtime"],
  ["diagnostics"],
  ["runner"],
  ["actions"],
  ["bot-data"],
  ["survival"],
  ["session"],
  ["navigation"],
  ["world"],
  ["execution"],
  ["utils"],
];

// Read top down: report, register, arbitrate, fight, respond, use weapons, stand, see, store, decide.
const SURVIVAL: Layers = [
  ["index.ts"],
  ["evidence"],
  ["reflexes", "guards", "baseline"],
  ["control"],
  ["combat"],
  ["responses"],
  ["weapons"],
  ["positioning"],
  ["perception"],
  ["state"],
  ["policy"],
];

// The run, top down: processes built on routes, the adapter, the run and its
// events, how it ended, then walking, searching, goals, movements and the world model.
const NAVIGATION: Layers = [
  ["index.ts"],
  ["runtime.ts"],
  ["diving.ts"],
  ["processes"],
  ["navigate.ts"],
  ["mineflayer"],
  ["orchestration"],
  ["telemetry"],
  ["outcome.ts"],
  ["steering"],
  ["execution"],
  ["search"],
  ["goals"],
  ["movements"],
  ["step-field.ts"],
  ["policy.ts"],
  ["world"],
];

// Procedures act on the world, watchers follow it over time, and the files left at the top level are facts.
const WORLD: Layers = [["index.ts"], ["procedures"], ["watchers"], ["*"]];

for (const [name, root, layers] of [
  ["src", src, SRC],
  ["survival", module("survival"), SURVIVAL],
  ["navigation", module("navigation"), NAVIGATION],
  ["world", module("world"), WORLD],
] as const) {
  test(`${name} imports only reach down its layers`, () => {
    assert.deepEqual(layerViolations(root, layers), []);
  });
}
