import type { Bot } from "mineflayer";
import { recordEvent, type SqlBotData } from "../../bot-data/index.js";
import type { CombatController } from "../control/combat/contract.js";

import { isDeepStrictEqual } from "node:util";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { ActionRunner } from "../../session/action-runner.js";
import type { ReflexDriver } from "../control/driver.js";
import type { Facts } from "../state/answered.js";
import type { SurvivalReceipt } from "./contract.js";
import { formatSurvivalOutcome } from "./format.js";
import type { SurvivalObserver } from "./status.js";

/** Internal receipts go to incident traces; only completed reflex outcomes notify the bot. */
export function attachSurvivalReceipts(
  bot: Bot,
  data: SqlBotData,
  runner: ActionRunner,
  driver: ReflexDriver,
  combat: CombatController,
  status: SurvivalObserver,
  navigation: Pick<NavigationRuntime, "onEvent">,
  recorded: (receipt: SurvivalReceipt) => void = () => {},
): Disposable {
  const publish = (kind: SurvivalReceipt["kind"], source: string, evidence: Facts) => {
    const receipt = { kind, source, evidence, status: status.snapshot() };
    recorded(receipt);
    return receipt;
  };
  let lastOwner = runner.ownership();
  const subscriptions = [
    navigation.onEvent((event) => {
      if (event.kind === "search_finished") publish("outcome", "search", JSON.parse(JSON.stringify(event)));
    }),
    driver.onTransition((event) => {
      const receipt = publish(event.kind, event.reflex, event.evidence);
      if (event.kind !== "outcome") return;
      recordEvent(data, bot.username, {
        type: "survival_outcome",
        observedAt: new Date().toISOString(),
        summary: formatSurvivalOutcome(receipt),
        payload: receipt,
      });
    }),
    runner.onOwnershipChange(() => {
      const owner = runner.ownership();
      if (isDeepStrictEqual(owner, lastOwner)) return;
      lastOwner = owner;
      publish("claim", "body", {
        current: owner.current,
        reserved: owner.reserved,
        transfer: owner.transfer
          ? { from: owner.transfer.from, to: owner.transfer.to, cause: { ...owner.transfer.cause } }
          : null,
      });
    }),
    combat.policy.onObservation((snapshot) =>
      publish("decision", "survival_policy", {
        revision: snapshot.revision,
        reason: snapshot.constraint ?? snapshot.lastChange,
        settling: snapshot.settling,
      }),
    ),
    combat.onDecision((event) => {
      // These are in-process typed observations; convert Vec3 instances to their
      // serialized coordinates at this persistence boundary only.
      const evidence: Facts = JSON.parse(JSON.stringify(event));
      publish(
        event.kind === "phase"
          ? "phase"
          : event.kind === "engagement" && event.state === "ended"
            ? "outcome"
            : "decision",
        "combat",
        evidence,
      );
    }),
  ];
  return {
    [Symbol.dispose]: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}
