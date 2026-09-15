import { executionCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot, BotEvents } from "mineflayer";
import { defineAction, type ActionContext } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  parseSendMessageRequest,
  sendMessageAnnotations,
  sendMessageOutcomes,
  SEND_MESSAGE,
  SEND_MESSAGE_DESCRIPTION,
  sendMessageInputSchema,
  sendMessageResultSchema,
  type SendMessageRequest,
  type SendMessageResult,
} from "./contract.js";

const MESSAGE_ECHO_TIMEOUT_MS = 5_000;

type MessageDelivery =
  | { readonly kind: "observed" }
  | { readonly kind: "not_observed" }
  | { readonly kind: "send_failed"; readonly cause: unknown };

type ChatListener = BotEvents["chat"];

/** Send one message after arming observation so a synchronous echo cannot be missed. */
export async function sendMessage(
  bot: Bot,
  request: SendMessageRequest,
  context: ActionContext,
): Promise<SendMessageResult> {
  context.signal?.throwIfAborted();
  const delivery = await observePublicMessage(bot, request.message, context);
  switch (delivery.kind) {
    case "observed":
      return { status: "succeeded", message: request.message };
    case "not_observed":
      return {
        status: "failed",
        error: sendMessageOutcomes.notObserved(MESSAGE_ECHO_TIMEOUT_MS / 1_000),
        message: request.message,
      };
    case "send_failed":
      return {
        status: "failed",
        error: sendMessageOutcomes.sendFailed(delivery.cause),
        message: request.message,
      };
  }
}

function observePublicMessage(bot: Bot, message: string, context: ActionContext): Promise<MessageDelivery> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      bot.off("chat", onChat);
      context.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const finish = (delivery: MessageDelivery) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(delivery);
    };
    const onChat: ChatListener = (username, observedMessage) => {
      if (username.toLowerCase() === bot.username.toLowerCase() && observedMessage === message) {
        finish({ kind: "observed" });
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(context.signal?.reason ?? new Error("Message action cancelled."));
    };

    bot.on("chat", onChat);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    // Mineflayer chat() has no acknowledgement. Without this observation
    // window, a muted or suppressing server could hold the foreground lock forever.
    timer = setTimeout(() => finish({ kind: "not_observed" }), MESSAGE_ECHO_TIMEOUT_MS);
    try {
      bot.chat(message);
    } catch (cause) {
      finish({ kind: "send_failed", cause });
    }
  });
}

export function formatSendMessageResult(result: SendMessageResult): string {
  const observation =
    result.status === "succeeded" ? "Public chat echo observed." : `**Observed stop:** ${result.error}`;
  return `${observation}\n\n${markdownCodeBlock(result.message)}`;
}

export function createSendMessageAction(bot: Bot) {
  return defineAction({
    checkpointSchema: executionCheckpointSchema,
    name: SEND_MESSAGE,
    description: SEND_MESSAGE_DESCRIPTION,
    inputSchema: sendMessageInputSchema,
    resultSchema: sendMessageResultSchema,
    formatResult: formatSendMessageResult,
    execution: { kind: "task" },
    annotations: sendMessageAnnotations,
    parse: parseSendMessageRequest,
    execute: (request, context) => sendMessage(bot, request, context),
  });
}
