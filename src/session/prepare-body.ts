import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../navigation/index.js";

/** Reset the admitted body before an action or survival response begins movement. */
export async function prepareBotForMovement(bot: Bot, navigation: NavigationRuntime): Promise<void> {
  bot.clearControlStates();
  navigation.cancel("foreground action preparation");
  bot.deactivateItem();

  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  if (bot.entity.vehicle) bot.dismount();
  if (bot.isSleeping) await bot.wake();
}
