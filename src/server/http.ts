/**
 * Persistent localhost Streamable HTTP transport for the Minecraft MCP
 * adapter. MCP client sessions are disposable; the supplied Minecraft action
 * session belongs to the process hosting this application.
 */
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from
  "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/** The transport host needs lifecycle operations, not one SDK build's nominal server class. */
export interface MinecraftMcpHostedServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

interface TransportRecord {
  lastActiveAt: number;
  server: MinecraftMcpHostedServer;
  transport: StreamableHTTPServerTransport;
}

export interface MinecraftMcpHttpApplicationOptions {
  createServer(): MinecraftMcpHostedServer;
  clientIdleTimeoutMs?: number;
  health?(): unknown;
  host?: string;
  log?(message: string): void;
}

/**
 * Purpose: Host any number of short-lived MCP client sessions above one
 * process-owned Minecraft session without coupling transport closure to bot
 * shutdown.
 *
 * Removal condition: Delete when the MCP SDK provides an equivalent
 * multi-session localhost application host with origin validation and explicit
 * lifecycle cleanup.
 */
export function createMinecraftMcpHttpApplication(
  options: MinecraftMcpHttpApplicationOptions,
) {
  const host = options.host || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `Minecraft MCP HTTP must bind to loopback; received "${host}".`,
    );
  }

  const app = createMcpExpressApp({ host });
  const transports = new Map<string, TransportRecord>();
  const log = options.log || (() => undefined);
  const clientIdleTimeoutMs = Math.max(
    60_000,
    options.clientIdleTimeoutMs ?? 30 * 60_000,
  );
  const idleReaper = setInterval(() => {
    const cutoff = Date.now() - clientIdleTimeoutMs;
    for (const [sessionId, record] of transports) {
      if (record.lastActiveAt >= cutoff) continue;
      transports.delete(sessionId);
      log(`MCP client session expired: ${sessionId}`);
      void record.server.close();
    }
  }, Math.min(60_000, clientIdleTimeoutMs));
  idleReaper.unref();

  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (!origin) {
      next();
      return;
    }
    try {
      const hostname = new URL(origin).hostname;
      if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
        next();
        return;
      }
    } catch {
      // The invalid origin is rejected below.
    }
    response.status(403).json({
      error: "Minecraft MCP accepts requests only from localhost origins.",
    });
  });

  app.get("/health", (_request, response) => {
    const minecraft = options.health?.();
    const healthy = (
      !minecraft ||
      typeof minecraft !== "object" ||
      (minecraft as { connected?: boolean }).connected !== false
    );
    response.status(healthy ? 200 : 503).json({
      ok: healthy,
      transport: "streamable-http",
      clientSessions: transports.size,
      ...(minecraft ? { minecraft } : {}),
    });
  });

  app.post("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    try {
      if (typeof sessionId === "string" && transports.has(sessionId)) {
        const record = transports.get(sessionId)!;
        record.lastActiveAt = Date.now();
        await record.transport.handleRequest(
          request,
          response,
          request.body,
        );
        return;
      }

      if (sessionId || !isInitializeRequest(request.body)) {
        response.status(sessionId ? 404 : 400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Missing or invalid MCP session.",
          },
          id: null,
        });
        return;
      }

      const server = options.createServer();
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => {
          transports.set(initializedId, {
            lastActiveAt: Date.now(),
            server,
            transport,
          });
          log(`MCP client session connected: ${initializedId}`);
        },
      });
      transport.onclose = () => {
        const closedId = transport.sessionId;
        if (!closedId) return;
        transports.delete(closedId);
        log(`MCP client session disconnected: ${closedId}`);
      };
      transport.onerror = (error) => {
        log(`MCP transport error: ${error.message}`);
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      log(
        `MCP request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal Minecraft MCP error.",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports.has(sessionId)) {
      response.status(sessionId ? 404 : 400).send("Missing or invalid MCP session.");
      return;
    }
    const record = transports.get(sessionId)!;
    record.lastActiveAt = Date.now();
    await record.transport.handleRequest(request, response);
  });

  app.delete("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId !== "string" || !transports.has(sessionId)) {
      response.status(sessionId ? 404 : 400).send("Missing or invalid MCP session.");
      return;
    }
    const record = transports.get(sessionId)!;
    record.lastActiveAt = Date.now();
    await record.transport.handleRequest(request, response);
  });

  return {
    app,
    get clientSessionCount(): number {
      return transports.size;
    },
    async close(): Promise<void> {
      clearInterval(idleReaper);
      const records = [...transports.values()];
      transports.clear();
      await Promise.allSettled(records.map(({ server }) => server.close()));
    },
  };
}
