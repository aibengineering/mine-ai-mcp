import type { Bot } from "mineflayer";
import { observedEyeHeight } from "./block-visibility.js";
import { entityDimensions } from "./entity-dimensions.js";
import { exposedBodyFrom } from "./entity-geometry.js";

/** A ledge can hide the centre of a large mob while its nearer face remains exposed. */
export function hasExposedBody(bot: Bot, entity: Parameters<Bot["attack"]>[0]): boolean {
  const eye = bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0);
  return exposedBodyFrom(bot.world, eye, { position: entity.position, ...entityDimensions(bot, entity) });
}
