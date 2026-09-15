import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { findPlacementSupport, placeBlock } from "../../../world/placement.js";
import type { CombatPolicy } from "../../policy/combat/contract.js";
import { extinguishFireAt } from "../fire-clearance.js";
import { capBlock } from "./hide-blocks.js";

export type ProtectionBuild =
  | { readonly kind: "built"; readonly placed: readonly Vec3[] }
  | { readonly kind: "blocked"; readonly placed: readonly Vec3[]; readonly reason: string };

/** A wall must fill its cell. A fence's bounding-box label is not a closed wall. */
export function fullProtectionBlock(block: ReturnType<Bot["blockAt"]>): boolean {
  return (
    block?.shapes?.some(([x, y, z, xx, yy, zz]) => x === 0 && y === 0 && z === 0 && xx === 1 && yy >= 1 && zz === 1) ??
    false
  );
}

/**
 * One construction transaction for every protective shape. Its caller owns
 * the body and decides whether changed contact or footing permits another cell.
 * Each observed placement supplies the next support; no optimistic packet batch
 * can claim a finished wall while the server has rejected an intermediate cell.
 */
export async function buildProtection(
  bot: Bot,
  cells: readonly Vec3[],
  options: {
    readonly signal: AbortSignal;
    readonly mayContinue: () => string | null;
    readonly terrain: Readonly<CombatPolicy["terrain"]>;
    /** Some hazards destroy ordinary walls; selection and existing cover must agree. */
    readonly blockNames?: readonly string[];
  },
): Promise<ProtectionBuild> {
  const { signal, mayContinue, terrain } = options;
  const protects = (block: ReturnType<Bot["blockAt"]>) =>
    fullProtectionBlock(block) && (!options.blockNames || options.blockNames.includes(block!.name));
  const pending = [...new Map(cells.map((cell) => [cell.toString(), cell])).values()];
  const placed: Vec3[] = [];
  const blocked = (reason: string): ProtectionBuild => ({ kind: "blocked", placed, reason });
  while (pending.length) {
    signal.throwIfAborted();
    const changed = mayContinue();
    if (changed) return blocked(changed);
    const complete = pending.findIndex((cell) => protects(bot.blockAt(cell)));
    if (complete >= 0) {
      pending.splice(complete, 1);
      continue;
    }
    if (!terrain.place) return blocked("Combat placement prohibited by policy.");
    const item = capBlock(bot, options.blockNames);
    if (!item) return blocked("no block worth placing is carried");
    const index = pending.findIndex((cell) => findPlacementSupport(bot, cell) !== null);
    if (index < 0)
      return blocked(`No reachable supporting face for remaining protection cells: ${pending.join(", ")}.`);
    const cell = pending[index]!;
    if ((await extinguishFireAt(bot, cell, signal, terrain.dig)) === "blocked")
      return blocked(`Fire could not be cleared from protection cell ${cell}.`);
    const changedAfterClearing = mayContinue();
    if (changedAfterClearing) return blocked(changedAfterClearing);
    const current = bot.blockAt(cell);
    if (!isReplaceableForPlacement(current))
      return blocked(
        `Protection cell ${cell} contains ${current?.name ?? "unobserved terrain"}, which cannot be replaced by placement.`,
      );
    const support = findPlacementSupport(bot, cell)!;
    const context = `${item.name} against ${support.support.name} face ${support.face.x},${support.face.y},${support.face.z}`;
    let result;
    try {
      result = await placeBlock(bot, {
        item,
        ...support,
        expectedCells: [cell],
        matches: protects,
        signal,
      });
    } catch (cause) {
      signal.throwIfAborted();
      return blocked(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (result.kind === "failed") return blocked(`${context}: ${result.error}`);
    placed.push(cell);
    pending.splice(index, 1);
  }
  return { kind: "built", placed };
}
