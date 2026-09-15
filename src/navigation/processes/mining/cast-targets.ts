import type { Bot } from "mineflayer";
import { asVec3, cellKey } from "../../../utils/index.js";
import { findLoadedBlockPositions } from "../../../world/loaded-block-scan.js";
import type { BlockPosition } from "../../index.js";
import type { MinePoolTarget, MineRequest } from "./mine-process.js";
import { carriesWaterBucket } from "./cast-obsidian.js";

/** Nearby sources share one pour target; failed stances remain attached to source cells. */
const LAVA_POOL_RADIUS = 8;
export class CastTargets {
  readonly #blacklist = new Set<string>();
  readonly #castStances = new Map<string, Set<string>>();
  constructor(
    private readonly bot: Bot,
    private readonly request: Pick<MineRequest, "cast" | "castSearchRadius">,
    private readonly maximumTargets: number,
  ) {}
  get blacklisted(): number {
    return this.#blacklist.size;
  }
  blacklist(target: MinePoolTarget): void {
    for (const source of target.sources) this.#blacklist.add(cellKey(source));
  }
  excludeStance(target: MinePoolTarget, feet: BlockPosition): void {
    for (const source of target.sources) {
      const key = cellKey(source);
      const stances = this.#castStances.get(key) ?? new Set<string>();
      stances.add(cellKey(feet));
      this.#castStances.set(key, stances);
    }
  }
  scan(): readonly MinePoolTarget[] {
    const definition = this.request.cast === null ? undefined : this.bot.registry?.blocksByName?.lava;
    if (!definition || !carriesWaterBucket(this.bot)) return [];
    const feet = this.bot.entity.position;
    const sources = findLoadedBlockPositions(this.bot, {
      center: feet,
      radius: this.request.castSearchRadius,
      stateIds: new Set([definition.minStateId]),
      limit: 256,
    })
      .filter((position) => !this.#blacklist.has(cellKey(position)))
      .sort((left, right) => feet.distanceSquared(left) - feet.distanceSquared(right));

    const pools: { position: BlockPosition; sources: BlockPosition[] }[] = [];
    for (const source of sources) {
      const cell = { x: source.x, y: source.y, z: source.z };
      // The scan is nearest-first, so the first source of each group is also
      // the one the route will reach first.
      const pool = pools.find((candidate) => asVec3(candidate.position).distanceTo(source) <= LAVA_POOL_RADIUS);
      if (pool) pool.sources.push(cell);
      else pools.push({ position: cell, sources: [cell] });
    }
    return pools.slice(0, this.maximumTargets).map((pool) => ({
      position: pool.position,
      kind: "pool" as const,
      sources: pool.sources,
      excludedStances: new Set(pool.sources.flatMap((source) => [...(this.#castStances.get(cellKey(source)) ?? [])])),
    }));
  }
}
