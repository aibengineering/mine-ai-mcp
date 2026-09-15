/** Shared pieces of the Markdown receipts, so two actions never say one thing two ways. */

/**
 * What follows an inventory count the server had not confirmed before the
 * action's short deadline. A receipt must never present such a count as the
 * outcome, and eat, place, and craft all say so in the same words.
 */
export function unconfirmedCount(confirmed: boolean): string {
  return confirmed ? "" : " (the server had not confirmed this count within the deadline)";
}

/** Render arbitrary action evidence without letting embedded backticks close the block. */
export function markdownCodeBlock(value: string, language = "text"): string {
  const longestFence = Math.max(0, ...[...value.matchAll(/`+/g)].map(([fence]) => fence.length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}
