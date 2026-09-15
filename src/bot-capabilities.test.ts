import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { botFixture } from "./test-support/bot.js";
import { assertBotPluginsLoaded, loadBotPlugins, requireBotTool } from "./bot-capabilities.js";

function pluginBot(tool?: { equipForBlock: () => Promise<void> }): Bot {
  return botFixture(
    {},
    {
      _client: new EventEmitter(),
      loadPlugin() {
        Object.assign(this, { tool: { equipForBlock: async () => undefined } });
      },
      ...(tool && { tool }),
    },
  );
}

test("loads the missing Tool plugin, and reports it at the runtime boundary if it goes missing", () => {
  const bot = pluginBot();

  loadBotPlugins(bot);

  assert.doesNotThrow(() => assertBotPluginsLoaded(bot));
  delete (bot as unknown as { tool?: unknown }).tool;
  assert.throws(() => assertBotPluginsLoaded(bot), /requires the mineflayer-tool plugin/);
});

test("keeps an existing Tool capability", () => {
  const equipForBlock = async () => undefined;
  const bot = pluginBot({ equipForBlock });
  let plugins = 0;
  bot.loadPlugin = () => {
    plugins += 1;
  };

  loadBotPlugins(bot);

  assert.equal(plugins, 0);
  assert.equal(requireBotTool(bot).equipForBlock, equipForBlock);
});
