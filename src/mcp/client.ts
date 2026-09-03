/**
 * MCP Client — Consume external MCP server tools
 */

import type { ToolRegistry, ToolDefinition, ToolResult } from "@dyna/contracts";
import type { McpServerConfig, McpTool } from "./types";

export interface McpServerConnection {
  config: McpServerConfig;
  tools: McpTool[];
  connected: boolean;
}

/**
 * Simplified MCP client that manages connections to external MCP servers.
 * In production, this would use stdio/SSE transports. For now, it provides
 * the interface and connection management.
 */
export class McpClient {
  private connections: Map<string, McpServerConnection> = new Map();
  private toolRegistry: ToolRegistry;
  private proxies: Map<string, McpToolProxy> = new Map();

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Connect to an external MCP server.
   * In a real implementation, this would spawn a stdio process or open an SSE connection.
   */
  async connect(config: McpServerConfig): Promise<McpTool[]> {
    // Track the server connection locally so discovered tools can be proxied
    // through the registry once they are registered.
    const connection: McpServerConnection = {
      config,
      tools: [],
      connected: true,
    };
    this.connections.set(config.name, connection);
    
    console.info(`MCP client: connected to ${config.name} (${config.transport})`);
    return [];
  }

  /**
   * Register discovered tools from a remote MCP server.
   */
  registerRemoteTools(serverName: string, tools: McpTool[]): void {
    const connection = this.connections.get(serverName);
    if (!connection) throw new Error(`Not connected to: ${serverName}`);
    
    connection.tools = tools;
    
    for (const tool of tools) {
      const proxy = new McpToolProxy(tool, serverName);
      this.proxies.set(tool.name, proxy);
      // Note: In real implementation, would register with toolRegistry
    }
  }

  /**
   * Disconnect from an MCP server and unregister its tools.
   */
  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    
    connection.connected = false;
    
    // Remove proxied tools
    for (const tool of connection.tools) {
      this.proxies.delete(tool.name);
    }
    
    this.connections.delete(name);
    console.info(`MCP client: disconnected from ${name}`);
  }

  /**
   * List all connected servers and their tools.
   */
  listConnections(): Array<{ name: string; transport: string; toolCount: number; connected: boolean }> {
    return Array.from(this.connections.values()).map(c => ({
      name: c.config.name,
      transport: c.config.transport,
      toolCount: c.tools.length,
      connected: c.connected,
    }));
  }

  /**
   * Get a proxy for calling a remote tool.
   */
  getProxy(toolName: string): McpToolProxy | undefined {
    return this.proxies.get(toolName);
  }
}

/**
 * Proxy that wraps a remote MCP tool as a local tool call.
 */
export class McpToolProxy {
  readonly tool: McpTool;
  readonly serverName: string;

  constructor(tool: McpTool, serverName: string) {
    this.tool = tool;
    this.serverName = serverName;
  }

  getDefinition(): ToolDefinition {
    return {
      name: `mcp.${this.serverName}.${this.tool.name}`,
      description: `[MCP:${this.serverName}] ${this.tool.description}`,
      inputSchema: this.tool.inputSchema,
      category: "execution",
      timeoutMs: 120_000,
      readOnly: false,
    };
  }

  /**
   * Execute this tool on the remote MCP server.
   * In production, this would send a tools/call request via the transport.
   */
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();
    
    // Placeholder: in real implementation, would send MCP request
    // via stdio (child_process) or SSE (HTTP)
    return {
      success: false,
      data: `MCP tool ${this.tool.name} on ${this.serverName} — transport not yet implemented`,
      durationMs: Date.now() - startTime,
      truncated: false,
    };
  }
}
