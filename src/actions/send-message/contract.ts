import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ActionOutput } from "../action.js";

export const SEND_MESSAGE = "send_message" as const;
export const SEND_MESSAGE_DESCRIPTION =
  "Send one public chat message and confirm that the connected bot observed its server echo. Commands and multiline messages are not accepted.";

const publicMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\r\n]*$/u, "Message must contain exactly one line.")
  .refine((message) => !message.startsWith("/"), "Message must be public chat, not a command.")
  .describe("One public chat message, from 1 to 256 characters. Commands and line breaks are rejected.");

export const sendMessageInputSchema = z.strictObject({
  message: publicMessageSchema,
});

export interface SendMessageRequest {
  readonly message: string;
}

export const sendMessageResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), message: z.string() }),
  z.strictObject({ status: z.literal("failed"), error: z.string(), message: z.string() }),
]);

export type SendMessageResult = z.output<typeof sendMessageResultSchema>;
export type SendMessageOutput = ActionOutput<typeof SEND_MESSAGE, SendMessageResult>;

export const sendMessageAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export function parseSendMessageRequest(input: unknown): SendMessageRequest {
  return sendMessageInputSchema.parse(input ?? {});
}

export const sendMessageOutcomes = {
  notObserved: (seconds: number) =>
    `[MESSAGE_NOT_OBSERVED] The bot did not observe its own public chat message within ${seconds} seconds.`,
  sendFailed: (cause: unknown) =>
    `[MESSAGE_SEND_FAILED] Mineflayer rejected the public chat message: ${cause instanceof Error ? cause.message : String(cause)}`,
} as const;
