import { Vec3 } from "vec3";
import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation } = context;
  const runner = new ActionRunner();
  const navigate = createNavigateAction(bot, navigation);
  const cases = ["adjacent-exit", "already-open", "replanned", "cancelled", "gate", "occupied"] as const;
  const details: string[] = [];
  for (const kind of cases) {
    // Fixture arrangement only. Each case exercises the ordinary action and
    // checks the server's block state after that action has settled.
    bot.chat("/kill @e[type=pig]");
    bot.chat("/fill 1 -60 0 6 -59 0 air");
    const open = kind === "already-open";
    const facing = kind === "adjacent-exit" ? "west" : "east";
    if (kind === "gate") {
      bot.chat("/setblock 2 -60 0 oak_fence_gate[facing=east,open=false,powered=false]");
    } else {
      bot.chat(`/setblock 2 -60 0 oak_door[facing=${facing},half=lower,hinge=left,open=${open},powered=false]`);
      bot.chat(`/setblock 2 -59 0 oak_door[facing=${facing},half=upper,hinge=left,open=${open},powered=false]`);
    }
    if (kind === "occupied") bot.chat("/summon pig 2.5 -60 0.5 {NoAI:1b,Silent:1b}");
    bot.chat(`/tp ${bot.username} ${kind === "adjacent-exit" ? "3.381 -60 0.495" : "0.5 -60 0.5"}`);
    await bot.waitForTicks(4);
    if (!(await standStill(context))) return { status: "failed", detail: `${kind}: arrangement did not settle.` };

    const cancellation = new AbortController();
    let injected = false;
    let replanned = false;
    const unsubscribe = navigation.onEvent((event) => {
      if (event.kind === "search_started" && event.reason === "world_changed") replanned = true;
      if (event.kind !== "step_completed" || injected || Math.floor(bot.entity.position.x) !== 2) return;
      injected = true;
      if (kind === "replanned") bot.chat("/setblock 4 -60 0 stone");
      if (kind === "cancelled") cancellation.abort("fixture stopped in the doorway");
    });
    const output = await runner
      .run(
        navigate,
        { x: kind === "adjacent-exit" ? 1 : 6, y: -60, z: 0, range: 0, scaffold: false, dig: kind !== "adjacent-exit" },
        AbortSignal.any([context.signal, cancellation.signal]),
      )
      .finally(unsubscribe);
    const states = (kind === "gate" ? [-60] : [-60, -59]).map(
      (y) => bot.blockAt(new Vec3(2, y, 0))?.getProperties().open,
    );
    const controlsReleased = Object.values(bot.controlState).every((held) => !held);
    const expectedOpen = kind === "already-open" || kind === "cancelled" || kind === "occupied";
    const expectedStatus = kind === "cancelled" ? "cancelled" : kind === "occupied" ? "failed" : "succeeded";
    const error = output.result.status === "succeeded" ? undefined : output.result.error;
    const reported = !expectedOpen || kind === "already-open" || error?.includes("Doorway at 2,-60,0");
    const passed =
      output.result.status === expectedStatus &&
      states.every((state) => state === expectedOpen) &&
      controlsReleased &&
      reported;
    details.push(
      `${kind}: ${output.result.status}, open=${states.join("/")}, controls released=${controlsReleased}, replanned=${replanned}, error=${error ?? "none"}`,
    );
    if (!passed) return { status: "failed", detail: details.join("; ") };
  }
  return { status: "succeeded", detail: details.join("; ") };
};
