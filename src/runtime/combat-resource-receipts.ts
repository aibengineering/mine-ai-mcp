export type CombatResourceReceipt =
  | { readonly kind: "arrow_release_command" }
  | { readonly kind: "food_eaten" }
  | { readonly kind: "scaffold_placed" };

const listeners = new WeakMap<object, Set<(receipt: CombatResourceReceipt) => void>>();

/** Publish an owned effect at the production boundary that physically verified it. */
export function recordCombatResourceReceipt(bot: object, receipt: CombatResourceReceipt): void {
  for (const listener of listeners.get(bot) ?? []) listener(receipt);
}

export function onCombatResourceReceipt(bot: object, listener: (receipt: CombatResourceReceipt) => void): () => void {
  const attached = listeners.get(bot) ?? new Set();
  attached.add(listener);
  listeners.set(bot, attached);
  return () => {
    attached.delete(listener);
    if (attached.size === 0) listeners.delete(bot);
  };
}
