import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { NavigationRuntime } from "../navigation/index.js";
import { carriedCount } from "../world/inventory-count.js";
import { placeCarriedBlockNearby, type NearbyPlacement } from "../world/nearby-placement.js";
import type { WorldBlock } from "../world/placement.js";
import { collectBlock } from "./collect-block/collect-block.js";
import { parseCollectBlockRequest } from "./collect-block/contract.js";
import type { ActionContext, ActionResult } from "./action.js";

export const temporaryWorkstationInputSchema = z
  .boolean()
  .optional()
  .describe(
    "Place a workstation already in inventory for this call, then collect it before returning. Fails if none is carried. Cancellation can leave the workstation behind.",
  );

export const workstationEvidenceSchema = z.strictObject({
  block: z.enum(["crafting_table", "furnace"]),
  position: z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  recovered: z.boolean(),
});

type WorkstationEvidence = z.output<typeof workstationEvidenceSchema>;
type WorkstationName = WorkstationEvidence["block"];

export interface WorkstationOperations {
  place(name: WorkstationName, signal?: AbortSignal): Promise<NearbyPlacement>;
  collect(
    name: WorkstationName,
    position: WorkstationEvidence["position"],
    context: ActionContext,
  ): Promise<ActionResult>;
}

export function workstationOperations(bot: Bot, navigation: NavigationRuntime): WorkstationOperations {
  return {
    place: (name, signal) => placeCarriedBlockNearby(bot, name, { signal }),
    collect: async (name, position, context) => {
      if (name === "furnace") {
        const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
        if (block?.name === "furnace") {
          const window = await bot.openFurnace(block);
          try {
            if (window.inputItem() || window.outputItem() || window.fuelItem()) {
              return { status: "failed", error: "The temporary furnace still contains items; it was left in place." };
            }
          } finally {
            window.close();
          }
        }
      }
      return collectBlock(
        bot,
        navigation,
        parseCollectBlockRequest({ block_name: name, ...position, scaffold: false }),
        context,
      );
    },
  };
}

/** Own only this call's placed block; a failed operation still returns its workstation. */
export async function useTemporaryWorkstation<Evidence extends object>(
  bot: Bot,
  name: WorkstationName,
  context: ActionContext,
  operations: WorkstationOperations,
  execute: (block: WorldBlock) => Promise<ActionResult & Evidence>,
  failure: (error: string) => ActionResult & Evidence,
): Promise<ActionResult & Evidence & { workstation?: WorkstationEvidence }> {
  context.signal?.throwIfAborted();
  if (carriedCount(bot, name) < 1) {
    return failure(`[WORKSTATION_NOT_CARRIED] No ${name} is carried for temporary use.`);
  }
  const placement = await operations.place(name, context.signal);
  if (placement.kind === "no_item" || placement.kind === "no_cell") {
    return failure(`[WORKSTATION_PLACEMENT_FAILED] ${name}: ${placement.kind}.`);
  }
  // A placement may report unsettled inventory even though the block appeared.
  // That cell is still ours to recover, but no crafting/cooking may begin.
  const placed = bot.blockAt(placement.position)?.name === name;
  if (!placed) {
    return failure(
      `[WORKSTATION_PLACEMENT_FAILED] ${name}: ${placement.kind === "failed" ? placement.error : "placed block was not observed"}.`,
    );
  }
  let result: ActionResult & Evidence;
  let recovered = false;
  let recoveryError = "";
  try {
    result =
      placement.kind === "placed"
        ? await execute(placement.block)
        : failure(`[WORKSTATION_PLACEMENT_FAILED] ${placement.error}`);
  } catch (cause) {
    context.signal?.throwIfAborted();
    result = failure(`[WORKSTATION_OPERATION_FAILED] ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    // Cancellation hands the body to the session/reflex. Do not move after that handoff.
    if (!context.signal?.aborted) {
      try {
        const collected = await operations.collect(name, placement.position, context);
        const remaining = bot.blockAt(placement.position);
        recovered = collected.status === "succeeded" && remaining !== null && remaining.name !== name;
        if (collected.status !== "succeeded") recoveryError = collected.error;
        else if (!recovered) recoveryError = "Removal of the placed workstation was not observed.";
      } catch (cause) {
        recoveryError = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }
  context.signal?.throwIfAborted();
  const workstation = {
    block: name,
    position: { x: placement.position.x, y: placement.position.y, z: placement.position.z },
    recovered,
  };
  if (recovered) return { ...result, workstation };
  const error = `[WORKSTATION_NOT_RECOVERED] ${name} at ${placement.position}: ${recoveryError}`;
  return {
    ...result,
    workstation,
    status: result.status === "succeeded" ? "partial" : result.status,
    error: result.status === "succeeded" ? error : `${result.error} ${error}`,
  };
}

export function formatWorkstation(workstation?: WorkstationEvidence): string[] {
  if (!workstation) return [];
  const { block, position, recovered } = workstation;
  return [
    `- Temporary ${block} at ${position.x}, ${position.y}, ${position.z}: ${recovered ? "collected back into inventory" : "not recovered"}`,
  ];
}
