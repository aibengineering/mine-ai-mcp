import { portalCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { useItemAt } from "../../world/index.js";
import { PLAYER_HALF_WIDTH } from "../../world/player-physics.js";
import { defineAction, type ActionContext } from "../action.js";
import { approachPortalBlock, type ActivatePortalDependencies } from "./approach.js";
import {
  activatePortalAnnotations,
  parseActivatePortalRequest,
  ACTIVATE_PORTAL,
  ACTIVATE_PORTAL_DESCRIPTION,
  activatePortalInputSchema,
  activatePortalResultSchema,
  type NetherPortalFrame,
  type PortalActivationEvidence,
  type ActivatePortalRequest,
  type ActivatePortalResult,
} from "./contract.js";
import { endFrameIntact, findEndFrame, hasEye, outsideEndOpening, type EndPortalFrame } from "./end-frame.js";
import { findNetherFrame, interiorCells } from "./nether-frame.js";

export type { ActivatePortalDependencies } from "./approach.js";

function portalCount(bot: Bot, cells: readonly Vec3[], name: string): number {
  return cells.filter((cell) => bot.blockAt(cell)?.name === name).length;
}

function result(
  bot: Bot,
  target: ActivatePortalRequest,
  portal: PortalActivationEvidence,
  error: string | null,
): ActivatePortalResult {
  const evidence = { dimension: bot.game.dimension, target, portal };
  if (error === null) return { ...evidence, status: "succeeded" };
  const progressed =
    portal.kind !== "unresolved" &&
    (portal.portalAfter > portal.portalBefore || (portal.kind === "end" && portal.eyesAfter > portal.eyesBefore));
  return { ...evidence, status: progressed ? "partial" : "failed", error };
}

async function activateNether(
  bot: Bot,
  request: ActivatePortalRequest,
  frame: NetherPortalFrame,
  context: ActionContext,
  dependencies: ActivatePortalDependencies,
): Promise<ActivatePortalResult> {
  const interior = interiorCells(frame);
  const before = portalCount(bot, interior, "nether_portal");
  context.observeProgress?.(() => ({ baseline: { target: { ...request } },
    checkpoint: { phase: "igniting_nether_frame", block: bot.blockAt(new Vec3(request.x, request.y, request.z))?.name ?? null,
      portalCells: portalCount(bot, interior, "nether_portal"), requiredPortalCells: interior.length },
    completion: { kind: "current", observed: portalCount(bot, interior, "nether_portal") === interior.length,
      owes: "Every interior cell is currently a nether portal block." },
  }));
  const finish = (error: string | null) => {
    const after = portalCount(bot, interior, "nether_portal");
    return result(
      bot,
      request,
      {
        kind: "nether",
        frame,
        portalBefore: before,
        portalAfter: after,
        activated: before < interior.length && after === interior.length,
      },
      error,
    );
  };
  if (before === interior.length) return finish(null);
  if (bot.game.dimension === "the_end")
    return finish("[PORTAL_WRONG_DIMENSION] Nether portals cannot activate in the End.");
  const item = bot.inventory.items().find((candidate) => candidate.name === "flint_and_steel");
  if (!item) return finish("[PORTAL_NO_FLINT_AND_STEEL] Bot inventory holds no flint_and_steel.");

  const floorCell = interior[0]!.offset(0, -1, 0);
  const approachError = await approachPortalBlock(
    bot,
    floorCell,
    (feet) => {
      const normal = frame.axis === "x" ? feet.z : feet.x;
      const plane = frame.axis === "x" ? frame.origin.z : frame.origin.x;
      return normal + PLAYER_HALF_WIDTH <= plane || normal - PLAYER_HALF_WIDTH >= plane + 1;
    },
    context,
    dependencies,
  );
  if (approachError) return finish(approachError);
  const observed = findNetherFrame(bot, interior[0]!);
  if (!("frame" in observed) || JSON.stringify(observed.frame) !== JSON.stringify(frame))
    return finish("[PORTAL_FRAME_CHANGED] The validated obsidian frame changed during approach.");
  const floor = bot.blockAt(floorCell);
  if (!floor) return finish("[PORTAL_TARGET_UNLOADED] The frame floor is no longer loaded.");
  const use = await dependencies.useItem(bot, {
    item,
    lookAt: floorCell.offset(0.5, 1.01, 0.5),
    on: { block: floor, face: { x: 0, y: 1, z: 0 } },
    expectedCells: interior.map((position) => ({ position, matches: (block) => block.name === "nether_portal" })),
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  if (portalCount(bot, interior, "nether_portal") === interior.length) return finish(null);
  return finish(
    `[PORTAL_FAILED] ${use.kind === "failed" ? use.error : "Not every interior cell became nether_portal."}`,
  );
}

async function activateEnd(
  bot: Bot,
  request: ActivatePortalRequest,
  frame: EndPortalFrame,
  context: ActionContext,
  dependencies: ActivatePortalDependencies,
): Promise<ActivatePortalResult> {
  const filled = () => frame.sockets.filter(({ position }) => hasEye(bot.blockAt(position))).length;
  const eyesBefore = filled();
  const before = portalCount(bot, frame.interior, "end_portal");
  context.observeProgress?.(() => ({ baseline: { target: { ...request } },
    checkpoint: { phase: "filling_end_sockets", block: bot.blockAt(new Vec3(request.x, request.y, request.z))?.name ?? null,
      filledSockets: filled(), portalCells: portalCount(bot, frame.interior, "end_portal"), requiredPortalCells: 9 },
    completion: { kind: "current", observed: portalCount(bot, frame.interior, "end_portal") === 9,
      owes: "All nine end portal cells are currently observed." },
  }));
  const finish = (error: string | null) => {
    const after = portalCount(bot, frame.interior, "end_portal");
    return result(
      bot,
      request,
      {
        kind: "end",
        center: frame.center,
        eyesBefore,
        eyesAfter: filled(),
        portalBefore: before,
        portalAfter: after,
        activated: before < 9 && after === 9,
      },
      error,
    );
  };
  if (before === 9) return finish(null);
  const carried = bot.inventory
    .items()
    .filter((item) => item.name === "ender_eye")
    .reduce((sum, item) => sum + item.count, 0);
  const missing = 12 - eyesBefore;
  if (carried < missing) return finish(`[PORTAL_MISSING_EYES] ${missing} empty sockets; ${carried} ender_eye carried.`);

  while (filled() < 12) {
    context.signal?.throwIfAborted();
    if (!endFrameIntact(bot, frame))
      return finish("[PORTAL_FRAME_CHANGED] The twelve inward-facing frame blocks are no longer observed.");
    const socket = frame.sockets
      .filter(({ position }) => !hasEye(bot.blockAt(position)))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]!;
    const approachError = await approachPortalBlock(
      bot,
      socket.position,
      (feet) => outsideEndOpening(frame, feet),
      context,
      dependencies,
    );
    if (approachError) return finish(approachError);
    if (!endFrameIntact(bot, frame)) return finish("[PORTAL_FRAME_CHANGED] The End frame changed during approach.");
    const block = bot.blockAt(socket.position);
    if (hasEye(block)) continue;
    if (!block) return finish("[PORTAL_TARGET_UNLOADED] The chosen socket is no longer loaded.");
    const item = bot.inventory.items().find((candidate) => candidate.name === "ender_eye");
    if (!item) return finish("[PORTAL_MISSING_EYES] No ender_eye remains for the empty socket.");
    const use = await dependencies.useItem(bot, {
      item,
      lookAt: socket.position.offset(0.5, 0.8, 0.5),
      on: { block, face: { x: 0, y: 1, z: 0 } },
      expectedCells: [
        { position: socket.position, matches: hasEye },
        // The last insertion must also observe the portal creation packet.
        ...(filled() === 11
          ? frame.interior.map((position) => ({
              position,
              matches: (cell: NonNullable<typeof block>) => cell.name === "end_portal",
            }))
          : []),
      ],
      signal: context.signal,
    });
    context.signal?.throwIfAborted();
    if (use.kind === "failed") return finish(`[PORTAL_FAILED] ${use.error}`);
    if (!hasEye(bot.blockAt(socket.position)))
      return finish("[PORTAL_FAILED] The clicked socket did not acquire an eye.");
  }
  return finish(
    portalCount(bot, frame.interior, "end_portal") === 9
      ? null
      : "[PORTAL_FAILED] All twelve sockets hold eyes, but the nine end_portal blocks were not observed.",
  );
}

export async function activatePortal(
  bot: Bot,
  request: ActivatePortalRequest,
  context: ActionContext,
  dependencies: ActivatePortalDependencies,
): Promise<ActivatePortalResult> {
  context.signal?.throwIfAborted();
  const target = new Vec3(request.x, request.y, request.z);
  context.observeProgress?.(() => ({ baseline: { target: { x: target.x, y: target.y, z: target.z } },
    checkpoint: { phase: "activating_portal", block: bot.blockAt(target)?.name ?? null },
    completion: { kind: "event", observed: false, owes: "The complete portal interior must be observed after activation." },
  }));
  const fail = (error: string) => result(bot, request, { kind: "unresolved" }, error);
  if (!bot.blockAt(target)) {
    const error = await approachPortalBlock(bot, target, () => true, context, dependencies);
    if (error) return fail(error);
  }
  const block = bot.blockAt(target);
  if (!block) return fail("[PORTAL_TARGET_UNLOADED] The named cell is not loaded after approach.");
  if (block.name === "end_portal_frame") {
    const frame = findEndFrame(bot, target);
    return frame
      ? activateEnd(bot, request, frame, context, dependencies)
      : fail(
          "[PORTAL_NO_FRAME] No complete ring of twelve inward-facing End frame blocks is loaded around the named socket.",
        );
  }
  const found = findNetherFrame(bot, target);
  return "frame" in found
    ? activateNether(bot, request, found.frame, context, dependencies)
    : fail(`[PORTAL_NO_FRAME] ${found.reason}`);
}

export function formatActivatePortalResult(output: ActivatePortalResult): string {
  const { portal } = output;
  const lines = [
    output.status === "succeeded"
      ? portal.kind !== "unresolved" && portal.activated
        ? `Activated the ${portal.kind} portal.`
        : "The portal was already active."
      : "Did not activate the portal.",
  ];
  if (portal.kind !== "unresolved") lines.push(`Portal cells: ${portal.portalBefore} → ${portal.portalAfter}.`);
  if (portal.kind === "end") lines.push(`Filled sockets: ${portal.eyesBefore} → ${portal.eyesAfter} of 12.`);
  if (output.status !== "succeeded") lines.push(output.error);
  return lines.join("\n");
}

export function createActivatePortalAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: ActivatePortalDependencies = {
    createMovements,
    navigate: navigation.navigate,
    useItem: useItemAt,
  },
) {
  return defineAction({
    checkpointSchema: portalCheckpointSchema,
    name: ACTIVATE_PORTAL,
    description: ACTIVATE_PORTAL_DESCRIPTION,
    inputSchema: activatePortalInputSchema,
    resultSchema: activatePortalResultSchema,
    formatResult: formatActivatePortalResult,
    annotations: activatePortalAnnotations,
    parse: parseActivatePortalRequest,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    begin: (request) => (context) => activatePortal(bot, request, context, dependencies),
  });
}
