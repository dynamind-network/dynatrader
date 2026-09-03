/**
 * MCP Server — Expose DynaTrader tools to external AI clients
 */

import type { ToolRegistry, ToolCall, ToolResult } from "@dyna/contracts";
import type { McpTool, McpRequest, McpResponse, McpToolCall, McpToolResult } from "./types";

export class McpServer {
  private tools: Map<string, McpTool> = new Map();
  private toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Register a tool to expose via MCP.
   */
  registerTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Auto-register all tools from the ToolRegistry.
   */
  registerAllTools(): void {
    const registered = this.toolRegistry.list();
    for (const handler of registered) {
      const def = handler.definition;
      this.tools.set(def.name, {
        name: def.name,
        description: def.description ?? "",
        inputSchema: def.inputSchema ?? {},
      });
    }
  }

  /**
   * Handle an MCP request and return a response.
   */
  async handleRequest(request: McpRequest): Promise<McpResponse> {
    try {
      switch (request.method) {
        case "tools/list":
          return this.handleListTools();
        case "tools/call":
          return this.handleCallTool(request.params as unknown as McpToolCall);
        case "ping":
          return { result: { pong: true }, id: request.id };
        default:
          return {
            error: { code: -32601, message: `Method not found: ${request.method}` },
            id: request.id,
          };
      }
    } catch (error) {
      return {
        error: { code: -32000, message: (error as Error).message },
        id: request.id,
      };
    }
  }

  private handleListTools(): McpResponse {
    const tools = Array.from(this.tools.values());
    return { result: { tools }, id: undefined };
  }

  private async handleCallTool(params: McpToolCall | undefined): Promise<McpResponse> {
    if (!params) {
      return { error: { code: -32602, message: "Missing params" } };
    }

    const tool = this.tools.get(params.name);
    if (!tool) {
      return { error: { code: -32601, message: `Tool not found: ${params.name}` } };
    }

    const toolCall: ToolCall = {
      tool: params.name,
      args: params.arguments,
      id: `mcp-${Date.now()}`,
      correlationId: `mcp-${Date.now()}`,
    };

    const result: ToolResult = await this.toolRegistry.execute(toolCall);

    const mcpResult: McpToolResult = {
      content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data) }],
      isError: !result.success,
    };

    return { result: mcpResult };
  }

  listTools(): McpTool[] {
    return Array.from(this.tools.values());
  }
}
