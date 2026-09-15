/**
 * Execute a prepared excavation from the current stance. Explicit target
 * callers own any preceding liquid sealing; ordinary collection is planned
 * through excavateGoal. Both use the same preparation as traversal.
 *
 * Arrival callbacks may call this while their navigation run is paused.
 */
import { type MovementPolicy } from "../movements/policy.js";
import { type BlockPosition, type WorldView, blockLabel, loadedObservation } from "../world/world.js";
import { waterMiningStance } from "../world/water.js";
import type { NavigationBot } from "../bot.js";
import { prepareExcavation } from "../movements/excavation.js";

export interface BreakBlockInPlaceOptions {
  readonly movements: MovementPolicy;
  readonly position: BlockPosition;
  readonly signal?: AbortSignal;
  /** Observe the tool of a committed dig immediately before its physical effect starts. */
  readonly onToolSelected?: (itemType: number | null) => void;
}

export type BreakBlockInPlaceResult =
  { readonly status: "broken" } | { readonly status: "failed"; readonly reason: string };

export type BreakBlockInPlace = (options: BreakBlockInPlaceOptions) => Promise<BreakBlockInPlaceResult>;

export async function breakBlockInPlace(
  dependencies: { readonly world: WorldView; readonly bot: NavigationBot },
  options: BreakBlockInPlaceOptions,
): Promise<BreakBlockInPlaceResult> {
  options.signal?.throwIfAborted();
  const observed = dependencies.world.blockAt(options.position.x, options.position.y, options.position.z);
  if (observed.kind !== "loaded") return { status: "failed", reason: "The block is not loaded." };
  const observation = dependencies.bot.observe();
  const feet = observation.position;
  const head = dependencies.world.blockAt(Math.floor(feet.x), Math.floor(feet.y + 1.62), Math.floor(feet.z));
  const waterWorkWorld: WorldView = {
    get revision() { return dependencies.world.revision; },
    subscribe: (listener) => dependencies.world.subscribe(listener),
    blockAt(x, y, z) {
      const block = dependencies.world.blockAt(x, y, z);
      // Water is the only admitted difference. Lava and all other policy
      // restrictions must still be checked against the observed world.
      return block.kind === "loaded" && block.traits.liquid === "water"
        ? loadedObservation(0, [], {
            ...block.traits, liquid: null, liquidSource: false, waterlogged: false, waterloggable: false,
          })
        : block;
    },
  };
  const policy: MovementPolicy = {
    ...options.movements,
    evaluateBreak(block, position, world) {
      const evaluation = options.movements.evaluateBreak(block, position, world);
      if (evaluation.decision.kind !== "prohibited" || evaluation.decision.cause !== "opens_into_liquid") return evaluation;
      const current = dependencies.bot.observe();
      const standing = {
        x: Math.floor(current.position.x),
        y: Math.floor(current.position.y),
        z: Math.floor(current.position.z),
      };
      if (!waterMiningStance((x, y, z) => world.blockAt(x, y, z), standing, current.stance === "supported")) return evaluation;
      return options.movements.evaluateBreak(block, position, waterWorkWorld);
    },
  };
  const excavation = prepareExcavation({
    world: dependencies.world,
    position: options.position,
    standing: observation.position,
    digContext: {
      submergedAtEyes: head.kind === "loaded" && head.traits.liquid === "water",
      onGround: observation.stance === "supported",
      aquaAffinity: observation.player.aquaAffinity,
      effects: observation.player.effects,
    },
    policy,
  });
  if (excavation.kind === "unavailable") return { status: "failed", reason: excavation.reason };
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    for (const dig of excavation.digs) {
      options.signal?.throwIfAborted();
      const before = dependencies.world.blockAt(dig.position.x, dig.position.y, dig.position.z);
      if (before.kind !== "loaded" || before.stateId !== dig.stateId) {
        return { status: "failed", reason: "The excavation changed before its next dig." };
      }
      const decision = policy.evaluateBreak(before, dig.position, dependencies.world).decision;
      if (decision.kind === "prohibited") return { status: "failed", reason: decision.reason };
      options.onToolSelected?.(dig.toolType);
      const handle = dependencies.bot.startEffect(
        {
          kind: "break",
          position: dig.position,
          expectedStateId: dig.stateId,
          toolType: dig.toolType,
          brings: dig.brings,
        },
        { runId: "in-place", planId: "in-place", stepId: `break:${blockLabel(dig.position)}`, attempt: 0 },
        controller.signal,
      );
      // The signal stops positioning, but the physical dig is owned by its
      // effect handle. Stop both before waiting for the body to be released.
      const cancel = () => handle.cancel();
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
      let completion;
      try {
        completion = await handle.completion;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
      options.signal?.throwIfAborted();
      if (completion.kind === "failed") return { status: "failed", reason: completion.observation };
      const after = dependencies.world.blockAt(dig.position.x, dig.position.y, dig.position.z);
      if (after.kind !== "loaded" || after.stateId === dig.stateId) {
        return { status: "failed", reason: "The excavation's block removal was not observed." };
      }
    }
    options.signal?.throwIfAborted();
    return { status: "broken" };
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}
