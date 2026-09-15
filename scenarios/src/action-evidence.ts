/** Capture one real default-Markdown MCP response for every published Minecraft action. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { createMinecraftMcpServer, createMinecraftRuntime } from "@aibengineering/mine-ai-mcp";

import { actionEvidenceJsonPath, type ActionEvidence } from "./action-evidence-file.ts";
import { renderActionEvidencePage } from "./action-evidence-page.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import { droppedItemName } from "../../src/world/item-pickup.ts";

const evidenceStepSchema = z.strictObject({
  action: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()),
  expected_error: z.string().min(1).optional(),
});

const evidenceParamsSchema = z.strictObject({
  steps: z.array(evidenceStepSchema).min(1),
});

type EvidenceStep = z.output<typeof evidenceStepSchema>;

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const evidence: ActionEvidence = {
    scenario: context.scenario.name ?? "mine-ai-mcp-evidence",
    minecraftVersion: context.scenario.minecraft.version,
    generatedAt: new Date().toISOString(),
    tools: [],
    calls: [],
  };

  let runtime: Awaited<ReturnType<typeof createMinecraftRuntime>> | undefined;
  let server: ReturnType<typeof createMinecraftMcpServer> | undefined;
  let client: Client | undefined;
  let completion: { status: "succeeded"; detail: string } | { status: "failed"; detail: string };

  try {
    runtime = await createMinecraftRuntime(bot, {
      botData: {
        storage: { kind: "temporary" },
        identity: {
          worldId: "mine-ai-mcp-evidence",
          scope: { kind: "bot", botId: bot.username },
        },
      },
    });
    server = createMinecraftMcpServer(runtime, bot.username);
    client = new Client({ name: "mine-ai-mcp-evidence", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    context.signal.throwIfAborted();

    const steps = evidenceParamsSchema.parse(context.scenario.params).steps;
    evidence.tools = (await client.listTools()).tools;
    assertCompleteCatalog(evidence.tools, steps);

    let precedingActionId: string | undefined;
    for (const [stepIndex, step] of steps.entries()) {
      context.signal.throwIfAborted();
      const argumentsValue: Record<string, unknown> = {
        ...step.arguments,
        rationale: `Capture representative evidence for ${step.action}.`,
      };
      if (step.action === "set_survival_policy")
        argumentsValue.expected_revision = runtime.status().survivalPolicy.revision;
      const action = runtime.actions.find((action) => action.name === step.action);
      const foreground = action?.execution.kind === "task" || action?.execution.kind === "resumable_task";
      if (foreground) {
        argumentsValue.submission_id = `evidence-${stepIndex}-${step.action}`;
        argumentsValue.response_format = "json";
      }
      if (step.action === "cancel_foreground_action") {
        if (!precedingActionId) throw new Error("Cancellation evidence requires a preceding settled action.");
        argumentsValue.action_id = precedingActionId;
      }
      // Entity IDs are assigned by the fresh server, never by the YAML.
      if (step.action === "barter") {
        const target = bot.nearestEntity((entity) => entity.name === "piglin" && entity.isValid);
        if (!target) throw new Error("The barter evidence requires its arranged adult piglin.");
        argumentsValue.piglin_id = target.id;
        // The preceding toss confirms the inventory change before the server
        // broadcasts its item entity. Establish this example's ground-drop
        // precondition before asking the zero-budget barter to retrieve it.
        let observed = false;
        for (let ticks = 0; ticks < 40; ticks++) {
          observed = Object.values(bot.entities).some(
            (entity) => entity.isValid && droppedItemName(entity) === argumentsValue.item_name,
          );
          if (observed) break;
          context.signal.throwIfAborted();
          await bot.waitForTicks(1);
        }
        if (!observed) throw new Error("The barter example did not observe the preceding dropped item.");
      }
      context.log(`${step.action} ${JSON.stringify(argumentsValue)}`);
      let response = CallToolResultSchema.parse(
        await client.callTool({ name: step.action, arguments: argumentsValue }),
      );
      evidence.calls.push({
        name: step.action,
        arguments: argumentsValue,
        response,
        expectedError: foreground ? undefined : step.expected_error,
      });
      if (foreground) {
        const acceptance = z.object({ response: z.object({ data: z.object({ state: z.literal("accepted"), actionId: z.string() }) }) }).parse(response.structuredContent).response.data;
        for (;;) {
          context.signal.throwIfAborted();
          const waitArguments = { action_id: acceptance.actionId, timeout_ms: 1000, response_format: "json",
            rationale: `Observe ${step.action} until its full result is available.` };
          const waited = CallToolResultSchema.parse(await client.callTool({ name: "wait_for_action", arguments: waitArguments }));
          evidence.calls.push({ name: "wait_for_action", arguments: waitArguments, response: waited });
          const outcome = z.object({ response: z.object({ data: z.object({ state: z.string() }) }) }).parse(waited.structuredContent).response.data;
          if (outcome.state === "pending") continue;
          if (outcome.state !== "settled") throw new Error(`Could not retrieve ${step.action}: ${JSON.stringify(waited)}`);
          precedingActionId = acceptance.actionId;
          // Capture the default formatter too. Retrieval must be repeatable and
          // the result remains available after retrieval releases the gate.
          const finalArguments = { action_id: acceptance.actionId, timeout_ms: 0,
            rationale: `Capture the complete default Markdown result for ${step.action}.` };
          response = CallToolResultSchema.parse(await client.callTool({ name: "wait_for_action", arguments: finalArguments }));
          evidence.calls.push({ name: "wait_for_action", arguments: finalArguments, response, expectedError: step.expected_error });
          break;
        }
      }
      const markdown = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (step.action !== "cancel_foreground_action" && !markdown.includes("**Vitals:**")) throw new Error(`${step.action} omitted survival vitals.`);
      if (step.expected_error) {
        if (!response.isError || !markdown.includes(step.expected_error))
          throw new Error(`${step.action} did not report its arranged boundary: ${step.expected_error}`);
      } else if (response.isError) throw new Error(`${step.action} unexpectedly failed: ${markdown}`);
      context.log(`${step.action}: ${response.isError ? "failed" : "succeeded"}`);
    }

    completion = {
      status: "succeeded",
      detail: `captured ${evidence.calls.length} MCP responses, including ${evidence.calls.filter((call) => call.expectedError).length} explicitly arranged failures`,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    evidence.failure = detail;
    completion = { status: "failed", detail };
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await runtime?.close();
      }
    }
  }

  try {
    evidence.generatedAt = new Date().toISOString();
    await mkdir(dirname(actionEvidenceJsonPath), { recursive: true });
    await writeFile(actionEvidenceJsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const pagePath = await renderActionEvidencePage();
    context.log(`evidence: ${actionEvidenceJsonPath}`);
    context.log(`page: ${pagePath}`);
  } catch (cause) {
    completion = {
      status: "failed",
      detail: `could not write evidence: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  return completion;
}

function assertCompleteCatalog(tools: readonly Tool[], steps: readonly EvidenceStep[]): void {
  const published = tools.map((tool) => tool.name);
  const configured = [...steps.map((step) => step.action), "wait_for_action"];
  const duplicates = configured.filter((name, index) => configured.indexOf(name) !== index);
  const missing = published.filter((name) => !configured.includes(name));
  const unknown = configured.filter((name) => !published.includes(name));

  if (duplicates.length === 0 && missing.length === 0 && unknown.length === 0) return;
  throw new Error(
    [
      duplicates.length > 0 ? `duplicate steps: ${[...new Set(duplicates)].join(", ")}` : "",
      missing.length > 0 ? `missing published tools: ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown tools: ${unknown.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
}
