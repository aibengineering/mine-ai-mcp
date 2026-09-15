import type { Bot } from "mineflayer";
import { DEFAULT_NAVIGATION_POLICY, type NavigationPolicy } from "../policy/contract.js";

const providers = new WeakMap<Bot, () => Readonly<NavigationPolicy>>();

/** Join low-level movement and response code to the connection's live policy without global mutable defaults. */
export function setNavigationPolicyProvider(bot: Bot, provider: () => Readonly<NavigationPolicy>): void {
  providers.set(bot, provider);
}

export function readNavigationPolicy(bot: Bot): Readonly<NavigationPolicy> {
  return providers.get(bot)?.() ?? DEFAULT_NAVIGATION_POLICY;
}
