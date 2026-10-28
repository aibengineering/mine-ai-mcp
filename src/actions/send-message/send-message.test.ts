import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../runner/action-runner.js";
import { botFixture } from "../../test-support/bot.js";
import {
  createSendMessageAction,
  formatSendMessageResult,
  sendMessageInputSchema,
} from "./index.js";

function chatBot(send: (bot: Bot, message: string) => void): Bot {
  const bot = botFixture({ username: "MineAI" });
  bot.chat = (message) => send(bot, message);
  return bot;
}

test("refuses a command or a line Mineflayer would split into several chat messages", () => {
  for (const message of ["/say hidden command", "first\nsecond", "x".repeat(257)]) {
    assert.throws(() => sendMessageInputSchema.parse({ message }));
  }
});

test("succeeds only after observing the bot's exact public chat echo", async () => {
  const sent: string[] = [];
  const bot = chatBot((chatBot, message) => {
    sent.push(message);
    chatBot.emit("chat", "SomeoneElse", message, null, {} as never, null);
    chatBot.emit("chat", chatBot.username, `${message}!`, null, {} as never, null);
    chatBot.emit("chat", chatBot.username, message, null, {} as never, null);
  });

  const action = createSendMessageAction(bot);
  const output = await new ActionRunner().run(action, { message: "Hello Alex" });

  assert.deepEqual(sent, ["Hello Alex"]);
  assert.deepEqual(output.result, { status: "succeeded", message: "Hello Alex" });
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(action.annotations?.idempotentHint, false);
  assert.match(formatSendMessageResult({ status: "succeeded", message: "Hello Alex" }), /echo observed/);
});

test("reports a Mineflayer send refusal with action-owned evidence", async () => {
  const bot = chatBot(() => {
    throw new Error("chat disabled");
  });

  const output = await new ActionRunner().run(createSendMessageAction(bot), { message: "Hello" });

  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error : "", /MESSAGE_SEND_FAILED.*chat disabled/);
  assert.equal("message" in output.result ? output.result.message : null, "Hello");
  assert.equal(bot.listenerCount("chat"), 0);
});

test("releases its echo listener when the caller cancels", async () => {
  const bot = chatBot(() => {});
  const controller = new AbortController();
  const pending = new ActionRunner().run(
    createSendMessageAction(bot),
    { message: "Hello" },
    controller.signal,
  );
  controller.abort(new Error("stop waiting for chat"));

  const output = await pending;
  assert.equal(output.result.status, "cancelled");
  assert.equal(bot.listenerCount("chat"), 0);
});
