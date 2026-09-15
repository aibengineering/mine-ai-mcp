import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  createMinecraftMcpServer,
  createMinecraftRuntime,
  queryBotDataResultSchema,
  readRecentEventsResultSchema,
  sendMessageResultSchema,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const cancelledResultSchema = z.strictObject({
  kind: z.literal("runtime_failure"),
  status: z.literal("cancelled"),
  error: z.string(),
});

const jsonResponseSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.object({
    response: z.object({
      format: z.literal("json"),
      data: z.object({ result: z.unknown() }),
    }),
  }),
});

function resultFrom(response: unknown): unknown {
  return jsonResponseSchema.parse(response).structuredContent.response.data.result;
}

async function waitUntil(check: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!check()) throw new Error(`Timed out waiting for ${description}.`);
}

/** Physically prove death cancellation, event delivery, respawn reuse, and durable history. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: {
        worldId: "player-death-runtime-event",
        scope: { kind: "bot", botId: bot.username },
      },
    },
  });
  const server = createMinecraftMcpServer(runtime, bot.username);
  const client = new Client({ name: "player-death-runtime-event", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const navigationCall = client.callTool({
      name: "navigate",
      arguments: {
        rationale: "Start real foreground movement so death must cancel its owner.",
        response_format: "json",
        x: 58,
        y: -60,
        z: 0,
        range: 1,
      },
    });
    await waitUntil(() => runtime.status().busy, "foreground navigation admission");
    await bot.waitForTicks(10);

    const deathObserved = new Promise<{ dimension: string; position: { x: number; y: number; z: number } }>(
      (resolve) => {
        bot.once("death", () =>
          resolve({
            dimension: bot.game.dimension,
            position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
          }),
        );
      },
    );
    const respawned = new Promise<void>((resolve) => bot.once("spawn", resolve));
    bot.chat("/kill @s");

    const death = await deathObserved;
    const navigationResponse = jsonResponseSchema.parse(await navigationCall);
    const cancelled = cancelledResultSchema.parse(resultFrom(navigationResponse));
    if (navigationResponse.isError !== true || !cancelled.error.startsWith(`${bot.username} died`)) {
      throw new Error(`Foreground navigation did not return the expected death cancellation: ${cancelled.error}`);
    }

    const eventResponse = await client.callTool({
      name: "read_recent_events",
      arguments: {
        rationale: "Read the one unread death lifecycle event.",
        response_format: "json",
      },
    });
    const eventPage = readRecentEventsResultSchema.parse(resultFrom(eventResponse));
    const deathEvents = eventPage.events.filter((event) => event.type === "player_death");
    if (deathEvents.length !== 1) throw new Error(`Expected one player_death event, observed ${deathEvents.length}.`);
    const event = deathEvents[0];
    if (!event || event.payload.dimension !== death.dimension) {
      throw new Error("The death event did not preserve the observed dimension.");
    }
    if (
      event.payload.position.x !== death.position.x ||
      event.payload.position.y !== death.position.y ||
      event.payload.position.z !== death.position.z
    ) {
      throw new Error(
        `Death position ${JSON.stringify(event.payload.position)} did not match ${JSON.stringify(death.position)}.`,
      );
    }

    // The runtime now preserves the server's death cause in cancellation too.
    // Its text is evidence, rather than the old fixed "username died." phrase.
    if (event.payload.cause !== null && !cancelled.error.includes(event.payload.cause))
      throw new Error("Death cancellation omitted the observed cause stored in the event.");

    await respawned;
    await bot.waitForTicks(2);
    const resumed = sendMessageResultSchema.parse(
      resultFrom(
        await client.callTool({
          name: "send_message",
          arguments: {
            rationale: "Prove a new foreground action completes after respawn.",
            response_format: "json",
            message: "Respawned and ready for new work.",
          },
        }),
      ),
    );
    if (resumed.status !== "succeeded") throw new Error("A new foreground action did not complete after respawn.");

    const historical = queryBotDataResultSchema.parse(
      resultFrom(
        await client.callTool({
          name: "query_bot_data",
          arguments: {
            rationale: "Confirm the read death remains in durable event history.",
            response_format: "json",
            sql: "SELECT event_type, payload_json FROM events WHERE event_type = 'player_death' ORDER BY event_id DESC LIMIT 1",
          },
        }),
      ),
    );
    if (historical.query.rows.length !== 1 || historical.query.rows[0]?.[0] !== "player_death") {
      throw new Error("The death event was not queryable after advancing the unread cursor.");
    }

    return {
      status: "succeeded",
      detail:
        `cancelled navigation, read one death at ${event.payload.position.x}, ${event.payload.position.y}, ` +
        `${event.payload.position.z} in ${event.payload.dimension}, resumed foreground work, and queried history`,
    };
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await server.close();
      } finally {
        await runtime.close();
      }
    }
  }
}
