import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../navigation/index.js";
import { botFixture } from "../test-support/bot.js";
import { prepareBotForMovement } from "./prepare-body.js";

// A body left holding a key, a drawn item, an open window, a vehicle or a bed
// cannot walk; preparation leaves none of them, and stops any route still
// running, whatever order it undoes them in.
test("movement preparation returns the bot to a neutral state", async () => {
  const held = new Set(["forward", "sprint"]);
  let usingItem = true, cancelled: string | null = null;
  const bot = botFixture({}, {
    clearControlStates: () => held.clear(),
    deactivateItem: () => { usingItem = false; },
    currentWindow: { id: 3 },
    closeWindow(window: unknown) { if (window === bot.currentWindow) bot.currentWindow = null; },
    dismount() { bot.entity.vehicle = null as never; },
    isSleeping: true,
    async wake() { bot.isSleeping = false; },
  });
  bot.entity.vehicle = { id: 9 } as never;
  const navigation = { cancel: (reason: string) => { cancelled = reason; } } as unknown as NavigationRuntime;

  await prepareBotForMovement(bot, navigation);

  assert.equal(held.size, 0, "controls cleared");
  assert.equal(usingItem, false, "held item released");
  assert.equal(bot.currentWindow, null, "window closed");
  assert.equal(bot.entity.vehicle, null, "dismounted");
  assert.equal(bot.isSleeping, false, "awake");
  assert.ok(cancelled, "navigation cancelled");
});
