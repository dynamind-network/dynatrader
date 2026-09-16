/**
 * MCP Client — Consume external MCP server tools
 */

import type { ToolRegistry, ToolDefinition, ToolResult, ToolCall } from "@dyna/contracts";
import type { McpServerConfig, McpTool } from "./types";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface McpServerConnection {
  config: McpServerConfig;
  tools: McpTool[];
  connected: boolean;
}

/**
 * MCP client that manages external server connections and registry proxies.
 */
export class McpClient {
  private connections: Map<string, McpServerConnection> = new Map();
  private toolRegistry: ToolRegistry;
  private proxies: Map<string, McpToolProxy> = new Map();
  private transports = new Map<string, { request: (method: string, params?: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> }>();

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Connect to an external MCP server.
   */
  async connect(config: McpServerConfig): Promise<McpTool[]> {
    const transport = config.transport === 'stdio'
      ? await createStdioTransport(config)
      : createHttpTransport(config);
    await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dynatrader', version: '3.0.0' } });
    await transport.request('notifications/initialized');
    const listed = await transport.request('tools/list') as { tools?: McpTool[] };
    const connection: McpServerConnection = {
      config,
      tools: listed.tools ?? [],
      connected: true,
    };
    this.connections.set(config.name, connection);
    this.transports.set(config.name, transport);
    this.registerRemoteTools(config.name, connection.tools);
    console.info(`MCP client: connected to ${config.name} (${config.transport})`);
    return connection.tools;
  }

  /**
   * Register discovered tools from a remote MCP server.
   */
  registerRemoteTools(serverName: string, tools: McpTool[]): void {
    const connection = this.connections.get(serverName);
    if (!connection) throw new Error(`Not connected to: ${serverName}`);
    
    connection.tools = tools;
    
    for (const tool of tools) {
      const proxy = new McpToolProxy(tool, serverName, this.transports.get(serverName)!.request);
      const name = proxy.getDefinition().name;
      this.proxies.set(name, proxy);
      this.toolRegistry.register(proxy);
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
      const proxyName = `mcp.${name}.${tool.name}`;
      this.proxies.delete(proxyName);
      this.toolRegistry.unregister?.(proxyName);
    }
    await this.transports.get(name)?.close();
    this.transports.delete(name);
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

  async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const proxy = this.proxies.get(`mcp.${serverName}.${toolName}`);
    if (!proxy) throw new Error(`MCP tool not found: ${serverName}/${toolName}`);
    const result = await proxy.execute({ tool: proxy.definition.name, args });
    if (!result.success) throw new Error(result.error ?? `MCP tool failed: ${serverName}/${toolName}`);
    return result.data;
  }
}

/**
 * Proxy that wraps a remote MCP tool as a local tool call.
 */
export class McpToolProxy {
  readonly tool: McpTool;
  readonly serverName: string;

  private request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;

  constructor(tool: McpTool, serverName: string, request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    this.tool = tool;
    this.serverName = serverName;
    this.request = request;
  }

  get definition(): ToolDefinition {
    return this.getDefinition();
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
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();
    
    const response = await this.request('tools/call', { name: this.tool.name, arguments: call.args }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    return {
      success: !response.isError,
      data: response.content ?? response,
      durationMs: Date.now() - startTime,
      truncated: false,
    };
  }
}

type RequestTransport = { request: (method: string, params?: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> };

function createHttpTransport(config: McpServerConfig): RequestTransport {
  if (!config.url) throw new Error(`MCP HTTP server '${config.name}' requires url`);
  let nextId = 1;
  return {
    async request(method, params) {
      const response = await fetch(config.url!, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.env as Record<string, string> ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
      if (!response.ok) throw new Error(`MCP ${config.name} HTTP ${response.status}`);
      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? 'MCP request failed');
      return payload.result;
    },
    async close() {},
  };
}

async function createStdioTransport(config: McpServerConfig): Promise<RequestTransport> {
  if (!config.command) throw new Error(`MCP stdio server '${config.name}' requires command`);
  const child = spawn(config.command, config.args ?? [], { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const lines: Interface = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();
  const failures = new Map<number, (reason: Error) => void>();
  lines.on('line', line => { try { const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }; if (msg.id == null) return; const reject = failures.get(msg.id); if (msg.error) { failures.delete(msg.id); pending.delete(msg.id); reject?.(new Error(msg.error.message ?? 'MCP request failed')); } else { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); failures.delete(msg.id); } } catch { /* ignore server logs */ } });
  child.on('error', error => { for (const reject of failures.values()) reject(error); });
  return {
    request(method, params) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, resolve); failures.set(id, reject); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); },
    async close() { lines.close(); child.kill(); },
  };
}
