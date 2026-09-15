import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMinecraftMcpHttpApplication } from "./http.js";

async function host(t: TestContext, health = () => ({ connected: true })) {
  const application = createMinecraftMcpHttpApplication({
    health,
    createServer: () => {
      const server = new McpServer({ name: "http-contract-test", version: "1" });
      server.registerTool("observe", { description: "Observe a shared runtime" }, async () => ({
        content: [{ type: "text", text: "runtime available" }],
      }));
      return server;
    },
  });
  const listener = createServer(application.app);
  t.after(async () => {
    await application.close();
    const closed = new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
    listener.closeAllConnections();
    await closed;
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  return { application, url: `http://127.0.0.1:${address.port}` };
}

test("independent HTTP clients can disconnect without closing another client's runtime access", async (t) => {
  const { application, url } = await host(t);
  const first = new Client({ name: "first", version: "1" });
  const second = new Client({ name: "second", version: "1" });
  const firstTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  const secondTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  try {
    await first.connect(firstTransport);
    await second.connect(secondTransport);
    assert.equal(application.clientSessionCount, 2);
    assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ["observe"]);
    await firstTransport.terminateSession();
    assert.equal(application.clientSessionCount, 1);
    const result = await second.callTool({ name: "observe", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "runtime available" }]);
    await application.close();
    assert.equal(application.clientSessionCount, 0);
    assert.equal((await fetch(`${url}/mcp`, {
      headers: { "mcp-session-id": secondTransport.sessionId! },
    })).status, 404);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("HTTP boundary rejects foreign origins and invalid sessions and reports disconnected health", async (t) => {
  let connected = false;
  const { url } = await host(t, () => ({ connected }));
  assert.equal((await fetch(`${url}/health`)).status, 503);
  connected = true;
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/health`, {
    headers: { origin: "https://example.com" },
  })).status, 403);
  assert.equal((await fetch(`${url}/health`, {
    headers: { origin: "http://localhost:1234" },
  })).status, 200);
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await fetch(`${url}/mcp`, { method })).status, 400);
    assert.equal((await fetch(`${url}/mcp`, {
      method,
      headers: { "mcp-session-id": "unknown" },
    })).status, 404);
  }
});
