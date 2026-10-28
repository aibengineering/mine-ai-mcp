import type { Bot } from "mineflayer";
import prismarineBlock from "prismarine-block";

export type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

export type BlockClass = {
  fromStateId(stateId: number, biomeId: number): MineflayerBlock;
  fromProperties(
    typeId: number,
    properties: Readonly<Record<string, string | number>>,
    biomeId: number,
  ): MineflayerBlock;
};

// Building the class walks every block in the registry to attach its collision
// shapes: about 1.6 ms per call, which callers on the survival tick path were
// paying several times per tick. The result depends only on the registry, so
// each registry gets one class for as long as it lives.
const blockClasses = new WeakMap<Bot["registry"], BlockClass>();

/** Prismarine's `Block` class bound to this bot's registry, for describing a state without a world position. */
export function blockClass(bot: Pick<Bot, "registry">): BlockClass {
  let Block = blockClasses.get(bot.registry);
  if (!Block) {
    Block = prismarineBlock(bot.registry);
    blockClasses.set(bot.registry, Block);
  }
  return Block;
}
