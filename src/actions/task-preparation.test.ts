import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../navigation/index.js";
import { prepareBotForMovement } from "../session/prepare-body.js";

test("movement preparation returns the bot to a neutral state", async () => {
  const calls: string[] = [];
  const bot = {
    clearControlStates: () => calls.push("controls"),
    deactivateItem: () => calls.push("item"),
    currentWindow: {},
    closeWindow: () => calls.push("window"),
    entity: { vehicle: {} },
    dismount: () => calls.push("vehicle"),
    isSleeping: true,
    wake: async () => calls.push("sleep"),
  } as unknown as Bot;

  const navigation = { cancel: () => calls.push("navigation") } as unknown as NavigationRuntime;
  await prepareBotForMovement(bot, navigation);

  assert.deepEqual(calls, ["controls", "navigation", "item", "window", "vehicle", "sleep"]);
});
