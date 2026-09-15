import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { defineAction, actionResultSchema, type Action } from "../actions/index.js";
import { DEBUG_EXECUTE_JAVASCRIPT } from "../actions/debug-execute-javascript/contract.js";
import type { ActionRequestInput, ActionResponseInput } from "../bot-data/action-call-log.js";
import { NOTIFICATION_HINT, notificationSummarySchema, type NotificationSummary } from "../bot-data/event-log.js";
import { ActionRunner } from "../session/action-runner.js";
import { createMinecraftMcpServer } from "./mcp.js";

const inputSchema = z.strictObject({
  outcome: z.enum(["succeeded", "partial", "failed"]).default("succeeded"),
});

const resultSchema = actionResultSchema({ value: z.number() });

function testAction<const Name extends string>(name: Name) {
  return defineAction({
    name,
    description: "A generic action used only to prove the MCP boundary.",
    inputSchema,
    resultSchema,
    formatResult: (result) => `Value: **${result.value}**`,
    execution: { kind: "information" },
    parse: (input: unknown) => inputSchema.parse(input),
    execute: async ({ outcome }) => {
      if (outcome === "failed") throw new Error("executor stopped");
      if (outcome === "partial") return { status: "partial" as const, error: "half finished", value: 1 };
      return { status: "succeeded" as const, value: 2 };
    },
  });
}

const action = testAction("test_action");

const markdownStructuredContentSchema = z.strictObject({
  response: z.strictObject({ format: z.literal("markdown"), markdown: z.string() }),
});

const jsonStructuredContentSchema = z.strictObject({
  response: z.strictObject({
    format: z.literal("json"),
    data: action.outputSchema,
  }),
  notifications: notificationSummarySchema,
});

interface ConnectedClientOptions {
  readonly actions?: readonly Action[];
  readonly notificationSummary?: () => NotificationSummary;
  readonly recordActionRequest?: (request: ActionRequestInput) => number;
  readonly recordActionResponse?: (response: ActionResponseInput) => void;
  readonly beforeRun?: () => void;
}

async function connectedClient(t: TestContext, options: ConnectedClientOptions = {}): Promise<Client> {
  const runner = new ActionRunner();
  const run: typeof runner.run = (definition, input, signal) => {
    options.beforeRun?.();
    return runner.run(definition, input, signal);
  };
  const server = createMinecraftMcpServer(
    {
      actions: options.actions ?? [action],
      run,
      notificationSummary: options.notificationSummary ?? (() => ({ unreadCount: 0 })),
      recordActionRequest: options.recordActionRequest ?? (() => 1),
      recordActionResponse: options.recordActionResponse ?? (() => undefined),
    },
    "TestBot",
  );
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test("publishes usage instructions, naming the debug action only where it is published", async (t) => {
  const ordinary = (await connectedClient(t)).getInstructions() ?? "";

  assert.match(ordinary, /controls and inspects Minecraft bot TestBot/);
  assert.match(ordinary, /Prefer the default Markdown response format for regular usage/);
  assert.doesNotMatch(ordinary, /debug_execute_javascript/);

  const withDebug =
    (await connectedClient(t, { actions: [action, testAction(DEBUG_EXECUTE_JAVASCRIPT)] })).getInstructions() ?? "";

  assert.match(withDebug, /Use debug_execute_javascript only when the standard actions cannot accomplish the task/);
  assert.match(withDebug, /explain in its rationale why debug access is required/);
});

test("records the request before execution and its exact MCP response afterward", async (t) => {
  const requests: ActionRequestInput[] = [];
  const responses: ActionResponseInput[] = [];
  const client = await connectedClient(t, {
    recordActionRequest: (request) => {
      requests.push(request);
      return 17;
    },
    recordActionResponse: (response) => responses.push(response),
    beforeRun: () => {
      assert.equal(requests.length, 1);
      assert.equal(responses.length, 0);
    },
  });
  const returned = await client.callTool({
    name: action.name,
    arguments: {
      rationale: "Keep the model's reason with this action.",
      outcome: "partial",
    },
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.actionName, action.name);
  assert.equal(request.rationale, "Keep the model's reason with this action.");
  assert.deepEqual(request.request, {
    outcome: "partial",
    rationale: "Keep the model's reason with this action.",
    response_format: "markdown",
  });
  assert.equal(responses.length, 1);
  const response = responses[0];
  assert.ok(response);
  assert.equal(response.requestId, 17);
  assert.equal(response.status, "partial");
  assert.ok(response.durationMs >= 0);
  assert.ok(Date.parse(response.respondedAt) >= Date.parse(request.requestedAt));
  // The log keeps the reply the client saw plus the action's structured result.
  assert.deepEqual(response.response, {
    ...returned,
    result: { status: "partial", error: "half finished", value: 1 },
    interruptions: [],
  });
});

test("publishes both response representations without duplicating action data", async (t) => {
  const client = await connectedClient(t);
  const listed = await client.listTools();

  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0]?.name, action.name);
  assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
  assert.deepEqual(listed.tools[0]?.inputSchema?.required, ["rationale"]);
  assert.deepEqual(Object.keys(listed.tools[0]?.inputSchema?.properties ?? {}).sort(), [
    "outcome",
    "rationale",
    "response_format",
  ]);
  const responseFormatProperty = z
    .object({ default: z.literal("markdown") })
    .parse(listed.tools[0]?.inputSchema?.properties?.response_format);
  assert.equal(responseFormatProperty.default, "markdown");
  assert.deepEqual(listed.tools[0]?.outputSchema?.required, ["response"]);
  assert.deepEqual(Object.keys(listed.tools[0]?.outputSchema?.properties ?? {}).sort(), ["notifications", "response"]);

  const missingRationale = await client.callTool({ name: action.name, arguments: {} });
  assert.equal(missingRationale.isError, true);
  const invalidFormat = await client.callTool({
    name: action.name,
    arguments: { rationale: "Try an unsupported representation.", response_format: "yaml" },
  });
  assert.equal(invalidFormat.isError, true);

  const called = await client.callTool({
    name: action.name,
    arguments: { rationale: "Prove that the generic MCP action can run." },
  });
  assert.equal(called.isError, false);
  const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(called.content);
  // The text travels in both places: a client that renders structuredContent
  // whenever it is present showed an empty envelope for every markdown call.
  assert.deepEqual(markdownStructuredContentSchema.parse(called.structuredContent), {
    response: { format: "markdown", markdown: content[0]?.text },
  });
  assert.match(content[0]?.text ?? "", /## `test_action`/);
  assert.match(content[0]?.text ?? "", /Value: \*\*2\*\*/);
  assert.doesNotMatch(content[0]?.text ?? "", /"value":2/);

  const json = await client.callTool({
    name: action.name,
    arguments: { rationale: "Request machine-readable evidence.", response_format: "json" },
  });
  const output = jsonStructuredContentSchema.parse(json.structuredContent).response.data;
  assert.deepEqual(json.content, []);
  assert.equal(output.action, action.name);
  assert.ok(output.durationMs >= 0);
  assert.deepEqual(output.result, { status: "succeeded", value: 2 });
});

/**
 * A caller that asked for JSON still has to be told why an action stopped.
 *
 * MCP clients render an error from `content`. JSON responses used to leave it
 * empty, so every failure reached the caller as a bare "Unknown error" with the
 * reason stranded in `structuredContent`. Observed on 2026-09-04: a portal
 * build that placed seven obsidian, dug two wrong blocks and reported exactly
 * which cell it was short arrived as two useless words.
 */
test("keeps partial evidence usable and reports a total stop as an MCP error in both formats", async (t) => {
  const client = await connectedClient(t);

  const partial = await client.callTool({
    name: action.name,
    arguments: { rationale: "Exercise the partial-result envelope.", outcome: "partial" },
  });
  assert.equal(partial.isError, false);
  assert.equal(markdownStructuredContentSchema.parse(partial.structuredContent).response.format, "markdown");
  assert.match(JSON.stringify(partial.content), /Value: \*\*1\*\*/);

  const failedMarkdown = await client.callTool({
    name: action.name,
    arguments: { rationale: "Exercise readable runtime failure translation.", outcome: "failed" },
  });
  assert.equal(failedMarkdown.isError, true);
  assert.match(
    markdownStructuredContentSchema.parse(failedMarkdown.structuredContent).response.markdown,
    /executor stopped/,
  );
  assert.match(JSON.stringify(failedMarkdown.content), /Runtime failure.*executor stopped/);

  const failed = await client.callTool({
    name: action.name,
    arguments: {
      rationale: "Exercise total executor failure translation.",
      response_format: "json",
      outcome: "failed",
    },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(jsonStructuredContentSchema.parse(failed.structuredContent).response.data.result, {
    kind: "runtime_failure",
    status: "failed",
    error: "executor stopped",
  });
  // A JSON caller is spared duplicated evidence, but never the reason it stopped.
  assert.deepEqual(failed.content, [{ type: "text", text: "test_action failed: executor stopped" }]);
});

test("adds unread notification awareness to both MCP response formats", async (t) => {
  const notifications = {
    unreadCount: 2,
    recentPreview: ["Alex: hello", "Sam: bring wood"],
    hint: NOTIFICATION_HINT,
  } satisfies NotificationSummary;
  const client = await connectedClient(t, { notificationSummary: () => notifications });

  const markdown = await client.callTool({
    name: action.name,
    arguments: { rationale: "Check the readable notification notice." },
  });
  assert.match(
    markdownStructuredContentSchema.parse(markdown.structuredContent).response.markdown,
    /2 unread notifications/,
  );
  assert.match(JSON.stringify(markdown.content), /2 unread notifications/);
  assert.match(JSON.stringify(markdown.content), /Alex: hello/);
  assert.match(JSON.stringify(markdown.content), /read_recent_events/);

  const json = await client.callTool({
    name: action.name,
    arguments: { rationale: "Check structured notification awareness.", response_format: "json" },
  });
  assert.deepEqual(json.content, []);
  assert.deepEqual(jsonStructuredContentSchema.parse(json.structuredContent).notifications, notifications);
});
