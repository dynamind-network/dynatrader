/**
 * MCP (Model Context Protocol) Runtime for Dyna-Trader
 *
 * Provides:
 * - Client mode: connect to external MCP servers, discover/use tools
 * - Server mode: expose Dyna-Trader tools as MCP endpoints
 * - Permission enforcement and audit logging for all MCP calls
 * - High-risk tool blocking (order placement, credential access, etc.)
 * - Real stdio and HTTP transport for MCP communication
 */

import { randomUUID } from "node:crypto";
import { PermissionRuntime, type PermissionContext } from "@dyna/permission-runtime";
import { AuditTrail } from "@dyna/audit";
import { Logger } from "@dyna/audit";
import type {
  MCPServerConfig as MCPServerConfigType,
  MCPToolDefinition as MCPToolDefinitionType,
  MCPRiskLevel,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
} from "./mcp-types";
import { StdioTransport } from "./mcp-stdio-transport";
import { HttpTransport } from "./mcp-http-transport";
import { MCPToolRegistry } from "./mcp-tool-registry";

// ---------------------------------------------------------------------------
// Re-export types (backward compatible with existing consumers)
// ---------------------------------------------------------------------------

/** Operating mode of the MCP runtime */
export type MCPRuntimeMode = "client" | "server" | "dual";

/** Risk classification for MCP tools */
export type RiskLevel = MCPRiskLevel;

/** Definition of an MCP tool */
export interface MCPToolDefinition extends MCPToolDefinitionType {}

/** Configuration for an external MCP server connection */
export interface MCPServerConfig extends MCPServerConfigType {}

/** Options for making an MCP tool call */
export interface MCPCallOptions {
  caller: string;
  callerType: "user" | "subagent" | "skill" | "tool" | "system";
  args: Record<string, unknown>;
  mode?: "research" | "backtest" | "paper" | "shadow" | "micro_live" | "live";
}

/** Result of an MCP tool call */
export interface MCPCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  auditId: string;
  durationMs: number;
}

/** Configuration for the MCP runtime */
export interface MCPRuntimeConfig {
  mode: MCPRuntimeMode;
  workspacePath: string;
  authConfig?: Record<string, unknown>;
  permissionRuntime?: PermissionRuntime;
  servers?: MCPServerConfig[];
  blockedTools?: string[];
  allowedHighRiskTools?: string[];
  serverTools?: MCPToolDefinition[];
}

/** Internal resolved config (all optional fields given defaults) */
interface ResolvedConfig {
  mode: MCPRuntimeMode;
  workspacePath: string;
  servers: MCPServerConfig[];
  blockedTools: string[];
  allowedHighRiskTools: string[];
  serverTools: MCPToolDefinition[];
}

/** Registered tool with its handler */
interface RegisteredTool {
  definition: MCPToolDefinition;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Server connection state with transport */
interface ServerConnection {
  config: MCPServerConfig;
  connected: boolean;
  transport?: StdioTransport | HttpTransport;
  registry: MCPToolRegistry;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MCPPermissionError extends Error {
  constructor(toolName: string, reasons: string[]) {
    super(`MCP permission denied for '${toolName}': ${reasons.join("; ")}`);
    this.name = "MCPPermissionError";
  }
}

export class MCPBlockedToolError extends Error {
  constructor(toolName: string) {
    super(`MCP tool '${toolName}' is blocked by security policy`);
    this.name = "MCPBlockedToolError";
  }
}

export class MCPToolNotFoundError extends Error {
  constructor(toolName: string) {
    super(`MCP tool '${toolName}' not found`);
    this.name = "MCPToolNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Default high-risk tool blocklist
// ---------------------------------------------------------------------------

const DEFAULT_BLOCKED_TOOLS: readonly string[] = Object.freeze([
  "place_order",
  "cancel_order",
  "withdraw_funds",
  "transfer_assets",
  "update_credentials",
  "delete_credentials",
  "modify_api_keys",
  "modify_risk_profile",
  "modify_trading_policy",
  "create_api_key",
  "delete_api_key",
  "execute_trade",
]);

// ---------------------------------------------------------------------------
// MCPRuntime
// ---------------------------------------------------------------------------

export class MCPRuntime {
  private readonly logger: Logger;
  private readonly audit: AuditTrail;
  private readonly permissionRuntime?: PermissionRuntime;
  private readonly config: ResolvedConfig;

  /** Client mode: tools discovered from external MCP servers */
  private readonly clientToolRegistry: MCPToolRegistry = new MCPToolRegistry();

  /** Server mode: tools exposed to external MCP clients */
  private readonly serverTools: Map<string, RegisteredTool> = new Map();

  /** Connections to external MCP servers (client mode) */
  private readonly connections: Map<string, ServerConnection> = new Map();

  /** Blocked tool names (includes default + user-configured) */
  private readonly blockedTools: Set<string>;

  /** Tools explicitly allowed despite being in the blocklist */
  private readonly allowedTools: Set<string>;

  constructor(config: MCPRuntimeConfig) {
    this.config = {
      mode: config.mode,
      workspacePath: config.workspacePath,
      servers: config.servers ?? [],
      blockedTools: config.blockedTools ?? [],
      allowedHighRiskTools: config.allowedHighRiskTools ?? [],
      serverTools: config.serverTools ?? [],
    };

    this.logger = new Logger("MCPRuntime");
    this.audit = new AuditTrail(config.workspacePath);
    this.permissionRuntime = config.permissionRuntime;

    // Build blocklist from defaults + user additions
    this.blockedTools = new Set<string>(DEFAULT_BLOCKED_TOOLS);
    for (const tool of this.config.blockedTools) {
      this.blockedTools.add(tool);
    }

    // Register allowed high-risk tools (remove from blocklist)
    this.allowedTools = new Set<string>();
    for (const tool of this.config.allowedHighRiskTools) {
      this.allowedTools.add(tool);
      this.blockedTools.delete(tool);
    }

    // Register initial server connections
    for (const server of this.config.servers) {
      this.connections.set(server.name, {
        config: server,
        connected: false,
        registry: new MCPToolRegistry(),
      });
    }

    // Initialize server tools from config
    if (this.config.mode === "server" || this.config.mode === "dual") {
      for (const toolDef of this.config.serverTools) {
        this.serverTools.set(toolDef.name, { definition: toolDef });
      }
    }

    this.logger.info(`MCPRuntime initialized in '${this.config.mode}' mode`);
  }

  // ================================================================
  // Client Mode: Connect to external MCP servers
  // ================================================================

  /**
   * Register an external MCP server to connect to (client mode).
   */
  async registerServer(serverConfig: MCPServerConfig): Promise<void> {
    if (this.config.mode === "server") {
      throw new Error("Cannot register external servers in server-only mode");
    }

    this.connections.set(serverConfig.name, {
      config: serverConfig,
      connected: false,
      registry: new MCPToolRegistry(),
    });

    this.logger.info(`External MCP server registered: ${serverConfig.name}`);
  }

  /**
   * Connect to all registered external MCP servers and discover their tools.
   * Creates the appropriate transport (stdio or HTTP) and establishes the connection.
   * Returns the list of successfully connected server names.
   */
  async connectServers(): Promise<string[]> {
    const connected: string[] = [];

    for (const [name, connection] of this.connections) {
      try {
        const transport = this.createTransport(connection.config);
        await transport.connect();
        connection.transport = transport;
        connection.connected = true;
        connected.push(name);
        this.logger.info(`Connected to MCP server: ${name}`);
      } catch (err) {
        this.logger.error(`Failed to connect to MCP server: ${name}`, err);
      }
    }

    return connected;
  }

  /**
   * Discover tools from a connected MCP server.
   * Calls the MCP `tools/list` method via the transport.
   */
  async discoverTools(serverName: string): Promise<MCPToolDefinition[]> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server '${serverName}' not found`);
    }
    if (!connection.connected || !connection.transport) {
      throw new Error(
        `Server '${serverName}' is not connected - call connectServers() first`,
      );
    }

    const transport = connection.transport;

    // Send tools/list request via JSON-RPC
    const request: MCPJsonRpcRequest = {
      jsonrpc: "2.0",
      id: `discover_${Date.now()}`,
      method: "tools/list",
    };

    let response: MCPJsonRpcResponse;
    try {
      response = await transport.send(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to discover tools from '${serverName}': ${message}`);
    }

    // Parse response to get tool definitions
    const rawTools = (response.result as { tools?: Array<Record<string, unknown>> })
      ?.tools;

    if (!rawTools || !Array.isArray(rawTools)) {
      // Fallback for servers that don't implement tools/list:
      // return empty tool list instead of erroring
      connection.registry.discoverTools(serverName, [], {
        includeTools: connection.config.includeTools,
        excludeTools: connection.config.excludeTools,
      });
      return [];
    }

    // Convert raw tool definitions to MCPToolDefinition
    const definitions: MCPToolDefinition[] = rawTools.map((t) => ({
      name: String(t.name ?? "unknown"),
      description: String(t.description ?? ""),
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      riskLevel: "low",
      category: "external",
    }));

    // Register tools in the server's tool registry with filtering
    const registered = connection.registry.discoverTools(serverName, definitions, {
      includeTools: connection.config.includeTools,
      excludeTools: connection.config.excludeTools,
    });

    return registered;
  }

  /**
   * Get all discovered client-side tools across all servers.
   */
  getClientTools(): MCPToolDefinition[] {
    // Collect tools from all server registries
    const allTools: MCPToolDefinition[] = [];
    for (const [, connection] of this.connections) {
      allTools.push(...connection.registry.getAllTools());
    }
    return allTools;
  }

  // ================================================================
  // Server Mode: Expose Dyna-Trader tools to MCP clients
  // ================================================================

  /**
   * Register a tool to expose via MCP server mode.
   */
  registerTool(
    definition: MCPToolDefinition,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    if (this.config.mode === "client") {
      throw new Error("Cannot register tools in client-only mode");
    }

    this.serverTools.set(definition.name, { definition, handler });
    this.logger.info(
      `Server tool registered: ${definition.name} (risk: ${definition.riskLevel})`,
    );
  }

  /**
   * Register multiple tools at once.
   */
  registerTools(
    tools: Array<{
      definition: MCPToolDefinition;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }>,
  ): void {
    for (const { definition, handler } of tools) {
      this.registerTool(definition, handler);
    }
  }

  /**
   * Get all registered server-side tool definitions.
   */
  getServerTools(): MCPToolDefinition[] {
    return Array.from(this.serverTools.values()).map((rt) => rt.definition);
  }

  // ================================================================
  // Call execution
  // ================================================================

  /**
   * Call a tool by name. Checks client tools first, then server tools.
   */
  async callTool(
    toolName: string,
    options: MCPCallOptions,
  ): Promise<MCPCallResult> {
    // Check if it's a namespaced client tool (mcp_<server>_<tool>)
    const clientMatch = this.findClientTool(toolName);
    if (clientMatch) {
      return this.executeClientToolCall(
        clientMatch.serverName,
        clientMatch.originalName,
        toolName,
        options,
      );
    }

    // Check server tools
    if (this.serverTools.has(toolName)) {
      return this.executeServerToolCall(toolName, options);
    }

    return {
      success: false,
      error: `Tool '${toolName}' not found in any registry`,
      auditId: "",
      durationMs: 0,
    };
  }

  /**
   * Check whether DYNA_AUTH_TOKEN is set and if so, validate the
   * incoming Authorization header (Bearer <token>). Throws on mismatch.
   * If no token is configured, logs a one-time warning but allows the call
   * for backward compatibility.
   */
  private static _authWarned = false;

  validateAuth(authorizationHeader?: string): void {
    const token = process.env.DYNA_AUTH_TOKEN;
    if (!token) {
      if (!MCPRuntime._authWarned) {
        this.logger.warn(
          "DYNA_AUTH_TOKEN is not set — MCP server mode is running WITHOUT authentication. " +
          "Set DYNA_AUTH_TOKEN to a secret value to enable bearer-token auth.",
        );
        MCPRuntime._authWarned = true;
      }
      return; // No auth configured — allow
    }

    // Require Authorization header
    if (!authorizationHeader) {
      throw new Error("Authentication required. Set DYNA_AUTH_TOKEN and provide Authorization: Bearer <token> header.");
    }

    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new Error("Invalid Authorization header format. Expected: Bearer <token>");
    }

    const providedToken = match[1]!;
    if (providedToken !== token) {
      throw new Error("Invalid authentication token.");
    }
  }

  /**
   * Handle an incoming MCP call from an external client (server mode).
   * Optionally requires `authorizationHeader` if DYNA_AUTH_TOKEN is set.
   */
  async handleServerCall(
    toolName: string,
    options: MCPCallOptions,
    authorizationHeader?: string,
  ): Promise<MCPCallResult> {
    try {
      this.validateAuth(authorizationHeader);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        auditId: "",
        durationMs: 0,
      };
    }
    if (!this.serverTools.has(toolName)) {
      throw new MCPToolNotFoundError(toolName);
    }
    return this.executeServerToolCall(toolName, options);
  }

  // ================================================================
  // Configuration & Query
  // ================================================================

  /** Get the current operating mode */
  getMode(): MCPRuntimeMode {
    return this.config.mode;
  }

  /** Get all configured server connections with their status */
  getConnections(): Array<{ name: string; connected: boolean }> {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      connected: conn.connected,
    }));
  }

  /**
   * Get detailed status for a specific server.
   */
  serverStatus(
    serverName: string,
  ): { name: string; connected: boolean; toolCount: number } | null {
    const connection = this.connections.get(serverName);
    if (!connection) return null;
    return {
      name: serverName,
      connected: connection.connected,
      toolCount: connection.registry.size,
    };
  }

  /**
   * Manually reconnect a specific server.
   * Disconnects and reconnects the transport, re-discovers tools.
   */
  async reconnectServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server '${serverName}' not found`);
    }

    // Disconnect existing transport
    if (connection.transport) {
      try {
        await connection.transport.disconnect();
      } catch (err) {
        this.logger.warn(
          `Error disconnecting '${serverName}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    connection.connected = false;
    connection.transport = undefined;

    // Reconnect
    const transport = this.createTransport(connection.config);
    await transport.connect();
    connection.transport = transport;
    connection.connected = true;

    // Re-discover tools
    try {
      await this.discoverTools(serverName);
    } catch (err) {
      this.logger.warn(
        `Tool re-discovery for '${serverName}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.info(`Reconnected to MCP server: ${serverName}`);
  }

  /** Add a tool to the blocklist */
  blockTool(toolName: string): void {
    this.blockedTools.add(toolName);
    this.allowedTools.delete(toolName);
  }

  /** Remove a tool from the blocklist */
  unblockTool(toolName: string): void {
    this.blockedTools.delete(toolName);
  }

  /** Explicitly allow a high-risk tool (removes from blocklist) */
  allowHighRiskTool(toolName: string): void {
    this.allowedTools.add(toolName);
    this.blockedTools.delete(toolName);
  }

  /** Check if a tool is currently blocked */
  isBlocked(toolName: string): boolean {
    if (this.allowedTools.has(toolName)) return false;
    return this.blockedTools.has(toolName);
  }

  /** Get the list of currently blocked tools */
  getBlockedTools(): string[] {
    return Array.from(this.blockedTools).filter((t) => !this.allowedTools.has(t));
  }

  // ================================================================
  // Private: Transport creation
  // ================================================================

  /**
   * Create the appropriate transport for a server config.
   */
  private createTransport(
    config: MCPServerConfig,
  ): StdioTransport | HttpTransport {
    if (config.transport === "stdio") {
      return new StdioTransport(config, {
        timeoutMs: 120_000,
        maxRetries: 3,
        retryDelayMs: 2000,
      });
    } else if (config.transport === "http") {
      return new HttpTransport(config, {
        timeoutMs: 120_000,
        healthCheckIntervalMs: 30_000,
      });
    }
    throw new Error(`Unknown transport type: ${(config as { transport: string }).transport}`);
  }

  // ================================================================
  // Private: Find client tool across all servers
  // ================================================================

  /**
   * Find a client tool across all server registries.
   * The tool name can be either a namespaced name (mcp_<server>_<tool>)
   * or a simple name (matches any server).
   */
  private findClientTool(
    toolName: string,
  ): { serverName: string; originalName: string } | null {
    // First try direct match (namespaced or registry lookup)
    for (const [, connection] of this.connections) {
      if (connection.registry.hasTool(toolName)) {
        return connection.registry.resolveName(toolName);
      }
    }

    return null;
  }

  // ================================================================
  // Private: Call execution with permission enforcement + audit
  // ================================================================

  /**
   * Execute a client-mode tool call (to an external MCP server).
   * Routes the call via the real transport.
   */
  private async executeClientToolCall(
    serverName: string,
    originalName: string,
    namespacedName: string,
    options: MCPCallOptions,
  ): Promise<MCPCallResult> {
    const startTime = Date.now();
    const auditId = `mcp_client_${namespacedName}_${Date.now()}_${this.randomSuffix()}`;

    try {
      const connection = this.connections.get(serverName);
      if (!connection || !connection.transport) {
        throw new Error(`Server '${serverName}' is not connected`);
      }

      const toolDef = connection.registry.getTool(namespacedName);
      if (!toolDef) {
        throw new MCPToolNotFoundError(namespacedName);
      }

      // Enforce blocklist
      if (this.isBlocked(namespacedName)) {
        throw new MCPBlockedToolError(namespacedName);
      }

      // Enforce permissions
      await this.checkPermissions(namespacedName, toolDef, options);

      // Route call through transport via JSON-RPC
      const request: MCPJsonRpcRequest = {
        jsonrpc: "2.0",
        id: `call_${Date.now()}`,
        method: "tools/call",
        params: {
          name: originalName,
          arguments: options.args,
        },
      };

      const response = await connection.transport.send(request);

      const durationMs = Date.now() - startTime;

      // Extract result data from response
      let data: unknown;
      if (response.result && typeof response.result === "object") {
        const result = response.result as Record<string, unknown>;
        data = result.content ?? result;
      } else {
        data = response.result;
      }

      await this.recordAudit(
        namespacedName,
        options,
        auditId,
        "success",
        durationMs,
        {
          mode: "client",
          args: options.args,
          serverName,
        },
      );

      return {
        success: true,
        data,
        auditId,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.recordAudit(
        namespacedName,
        options,
        auditId,
        "failure",
        durationMs,
        {
          mode: "client",
          args: options.args,
          serverName,
          error: errorMessage,
        },
      );

      return { success: false, error: errorMessage, auditId, durationMs };
    }
  }

  /**
   * Execute a server-mode tool call (handles incoming request).
   */
  private async executeServerToolCall(
    toolName: string,
    options: MCPCallOptions,
  ): Promise<MCPCallResult> {
    const startTime = Date.now();
    const auditId = `mcp_server_${toolName}_${Date.now()}_${this.randomSuffix()}`;

    try {
      const registered = this.serverTools.get(toolName);
      if (!registered) {
        throw new MCPToolNotFoundError(toolName);
      }

      const toolDef = registered.definition;

      // Enforce blocklist
      if (this.isBlocked(toolName)) {
        throw new MCPBlockedToolError(toolName);
      }

      // Enforce permissions
      await this.checkPermissions(toolName, toolDef, options);

      // Execute handler
      if (!registered.handler) {
        throw new Error(`No handler registered for tool '${toolName}'`);
      }

      const data = await registered.handler(options.args);
      const durationMs = Date.now() - startTime;

      await this.recordAudit(toolName, options, auditId, "success", durationMs, {
        mode: "server",
        args: options.args,
      });

      return { success: true, data, auditId, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.recordAudit(toolName, options, auditId, "failure", durationMs, {
        mode: "server",
        args: options.args,
        error: errorMessage,
      });

      return { success: false, error: errorMessage, auditId, durationMs };
    }
  }

  /**
   * Check permissions for a tool call via the PermissionRuntime.
   */
  private async checkPermissions(
    toolName: string,
    toolDef: MCPToolDefinition,
    options: MCPCallOptions,
  ): Promise<void> {
    if (!this.permissionRuntime) return;

    const permissionContext: PermissionContext = {
      actor: options.caller,
      actorType: options.callerType,
      action: `mcp:${toolName}`,
      resource: toolDef.category ?? "mcp",
      mode: options.mode ?? "research",
    };

    const permission =
      await this.permissionRuntime.checkPermission(permissionContext);
    if (!permission.allowed) {
      throw new MCPPermissionError(toolName, permission.reasons);
    }
  }

  /**
   * Record audit event for a tool call.
   */
  private async recordAudit(
    toolName: string,
    options: MCPCallOptions,
    auditId: string,
    result: "success" | "failure",
    durationMs: number,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      type: "tool_call",
      actor: options.caller,
      actorType: options.callerType,
      action: `mcp:${toolName}`,
      result,
      details: { auditId, durationMs, ...details },
    });
  }

  /** Generate a short random suffix for audit IDs */
  private randomSuffix(): string {
    return randomUUID().replace(/-/g, '').substring(0, 9);
  }
}