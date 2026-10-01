import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Publish the Minecraft session's fixed tool catalogue with compact output
 * schemas. Registration and call-time Zod validation still belong to McpServer.
 * The SDK's converter does not expose Zod's `reused` option, so only tools/list
 * uses a custom handler, through the SDK's public protocol API.
 */
export class ReferenceToolCatalogue {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly server: McpServer) {}

  readonly registerTool: McpServer["registerTool"] = (name, config, callback) => {
    const tool = this.server.registerTool(name, config, callback);
    this.tools.set(name, tool);
    return tool;
  };

  publish(): void {
    if (this.tools.size === 0) return;
    this.server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools].filter(([, tool]) => tool.enabled).map(([name, tool]): Tool => {
        // This catalogue owns only the Zod 4 object schemas registered by the
        // Minecraft factory, not arbitrary third-party registrations.
        if (!(tool.inputSchema instanceof z.ZodObject) || !(tool.outputSchema instanceof z.ZodObject)) {
          throw new Error(`Minecraft tool ${name} must have Zod object input and output schemas.`);
        }
        return {
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }) as Tool["inputSchema"],
          outputSchema: z.toJSONSchema(tool.outputSchema, {
            target: "draft-7", io: "output", reused: "ref",
          }) as Tool["outputSchema"],
          annotations: tool.annotations,
          execution: tool.execution,
          _meta: tool._meta,
        };
      }),
    }));
  }
}
