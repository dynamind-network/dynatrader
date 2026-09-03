import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';
import { BaseTool, MCPTool } from './base-tool.js';
import { MCPClientManager } from '../mcp/client.js';
import { MCPCommandHandler } from '../mcp/command-handler.js';
import { ToolExecutionPolicy } from './tool-execution-policy.js';
import { getErrorMessage } from '../utils/index.js';

interface ToolInfo {
  tool: BaseTool;
  category: string;
  tags: string[];
}

interface SchemaCacheEntry {
  schema: object;
  timestamp: number;
}

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

export class ToolRegistry {
  private tools = new Map<string, BaseTool>();
  private toolInfo = new Map<string, ToolInfo>();
  private allowedTools: Set<string> | null = null;
  private disallowedTools = new Set<string>();
  private mcpManager?: MCPClientManager;
  private mcpCommandHandler?: MCPCommandHandler;
  private executionPolicy = new ToolExecutionPolicy();
  private schemaCache = new Map<string, SchemaCacheEntry>();
  private cacheVersion = 0;
  private deferredTools = new Map<string, BaseTool>();
  private toolLoadOrder: string[] = [];
  private toolResultSizeLimit = 50_000;
  private serverToolMap = new Map<string, Set<string>>(); // serverName -> tool names

  register(tool: BaseTool, deferred = false, serverName?: string): void {
    if (deferred) {
      this.deferredTools.set(tool.name, tool);
      return;
    }

    if (this.tools.has(tool.name)) {
      console.warn(`Tool ${tool.name} is already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    this.toolInfo.set(tool.name, {
      tool,
      category: this.categorizeTool(tool),
      tags: this.extractTags(tool),
    });
    this.toolLoadOrder.push(tool.name);
    this.invalidateSchemaCache(tool.name);

    // Track server affiliation if provided
    if (serverName) {
      if (!this.serverToolMap.has(serverName)) {
        this.serverToolMap.set(serverName, new Set());
      }
      this.serverToolMap.get(serverName)!.add(tool.name);
    }
  }

  registerAll(tools: BaseTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    this.invalidateSchemaCache(name);
    this.toolInfo.delete(name);
    this.toolLoadOrder = this.toolLoadOrder.filter((n) => n !== name);

    // Remove from server tool mapping if present
    for (const [serverName, toolNames] of this.serverToolMap) {
      if (toolNames.has(name)) {
        toolNames.delete(name);
        if (toolNames.size === 0) {
          this.serverToolMap.delete(serverName);
        }
        break;
      }
    }

    return this.tools.delete(name);
  }

  /**
   * Unregister all tools belonging to a specific MCP server
   */
  unregisterToolsForServer(serverName: string): number {
    const toolNames = this.serverToolMap.get(serverName);
    if (!toolNames || toolNames.size === 0) {
      return 0;
    }

    let count = 0;
    for (const toolName of toolNames) {
      if (this.unregister(toolName)) {
        count++;
      }
    }

    this.serverToolMap.delete(serverName);
    return count;
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name) ?? this.deferredTools.get(name);
  }

  getExecutionPolicy(): ToolExecutionPolicy {
    return this.executionPolicy;
  }

  has(name: string): boolean {
    return this.tools.has(name) || this.deferredTools.has(name);
  }

  getToolNames(): string[] {
    return [...this.tools.keys(), ...this.deferredTools.keys()];
  }

  setAllowedTools(tools: string[]): void {
    // CRITICAL: Warn if allowedTools is empty — likely misconfiguration that blocks ALL tools
    if (tools.length === 0) {
      console.warn('[tool-registry] WARNING: allowedTools is empty — this will block ALL tools');
    }
    this.allowedTools = new Set(tools);
  }

  setDisallowedTools(tools: string[]): void {
    // CRITICAL: Validate tool names exist before adding to disallow list
    const unknownTools = tools.filter(t => !this.tools.has(t) && !this.deferredTools.has(t));
    if (unknownTools.length > 0) {
      console.warn(`[tool-registry] WARNING: Disallowing unknown tools: ${unknownTools.join(', ')}`);
    }
    this.disallowedTools = new Set(tools);
  }

  isToolAllowed(name: string): boolean {
    if (this.disallowedTools.has(name)) return false;
    if (this.allowedTools !== null) return this.allowedTools.has(name);
    return true;
  }

  getToolDefinitions(filter?: string[]): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];

    const sortedToolNames = [...this.toolLoadOrder].sort((a, b) => a.localeCompare(b));

    for (const name of sortedToolNames) {
      const tool = this.tools.get(name);
      if (tool && (!filter || filter.includes(name)) && this.isToolAllowed(name)) {
        definitions.push(tool.getDefinition());
      }
    }

    for (const [name, tool] of this.tools) {
      if (
        !this.toolLoadOrder.includes(name) &&
        (!filter || filter.includes(name)) &&
        this.isToolAllowed(name)
      ) {
        definitions.push(tool.getDefinition());
      }
    }

    return definitions;
  }

  getCachedSchema(toolName: string): object | null {
    const entry = this.schemaCache.get(toolName);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > SCHEMA_CACHE_TTL_MS) {
      this.schemaCache.delete(toolName);
      return null;
    }

    return entry.schema;
  }

  cacheSchema(toolName: string, schema: object): void {
    this.schemaCache.set(toolName, {
      schema,
      timestamp: Date.now(),
    });
  }

  invalidateSchemaCache(toolName?: string): void {
    if (toolName) {
      this.schemaCache.delete(toolName);
    } else {
      this.schemaCache.clear();
    }
    this.cacheVersion++;
  }

  getCacheVersion(): number {
    return this.cacheVersion;
  }

  getSchemaCacheStats(): { cached: number; size: number } {
    const now = Date.now();
    let validCount = 0;

    for (const entry of this.schemaCache.values()) {
      if (now - entry.timestamp <= SCHEMA_CACHE_TTL_MS) {
        validCount++;
      }
    }

    return {
      cached: validCount,
      size: this.schemaCache.size,
    };
  }

  async prepareTools(filter?: string[]): Promise<void> {
    for (const [name, tool] of this.tools) {
      if (filter && !filter.includes(name)) continue;
      if (!this.isToolAllowed(name)) continue;

      const maybeInitializable = tool as BaseTool & {
        initialize?: () => Promise<void> | void;
      };

      if (typeof maybeInitializable.initialize === 'function') {
        await maybeInitializable.initialize();
      }
    }
  }

  // CRITICAL: Rate limiting for tool execution — prevent abuse
  private executionTimestamps = new Map<string, number[]>();
  private readonly RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
  private readonly RATE_LIMIT_MAX_CALLS = 50; // Max 50 calls per tool per minute

  /**
   * CRITICAL: Check if tool execution exceeds rate limit.
   * Returns true if rate limit is exceeded.
   */
  private checkRateLimit(name: string): boolean {
    const now = Date.now();
    const timestamps = this.executionTimestamps.get(name) || [];

    // Remove timestamps outside the window
    const recent = timestamps.filter(t => now - t < this.RATE_LIMIT_WINDOW_MS);

    if (recent.length >= this.RATE_LIMIT_MAX_CALLS) {
      console.warn(`[security] Rate limit exceeded for tool: ${name} (${recent.length} calls in ${this.RATE_LIMIT_WINDOW_MS / 1000}s)`);
      return true;
    }

    recent.push(now);
    this.executionTimestamps.set(name, recent);
    return false;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, output: `Tool not found: ${name}` };
    if (!this.isToolAllowed(name))
      return { success: false, output: `Tool is not allowed: ${name}` };

    // CRITICAL: Rate limit check
    if (this.checkRateLimit(name)) {
      return { success: false, output: `Tool rate limit exceeded: ${name}. Please wait before retrying.` };
    }

    // CRITICAL: Validate input size to prevent memory exhaustion
    const inputStr = JSON.stringify(input);
    if (inputStr.length > 1024 * 1024) { // 1MB input limit
      return { success: false, output: `Input too large for tool: ${name}. Maximum 1MB allowed.` };
    }

    // CRITICAL: Audit trail for tool execution — log timestamp, tool name, and whether it's destructive
    const executionTime = new Date().toISOString();
    const isDestructive = tool.isDestructive;
    const isReadonly = tool.readOnly;

    try {
      const result = await tool.execute(input, context);

      // Log tool execution for security audit trail
      if (isDestructive || !isReadonly) {
        console.log(`[audit] ${executionTime} TOOL_EXECUTED: ${name} (destructive=${isDestructive})`);
      }

      // CRITICAL: Sanitize output to prevent sensitive data leakage in error messages
      if (result.output && !result.success) {
        const sanitized = result.output
          .replace(/[a-f0-9]{32,}/gi, '[REDACTED]')
          .replace(/0x[a-fA-F0-9]{40}/g, '[ADDRESS]')
          .replace(/api[_-]?key[^,]*/gi, '[API_KEY]');
        return { ...result, output: sanitized };
      }

      return result;
    } catch (err) {
      console.log(`[audit] ${executionTime} TOOL_FAILED: ${name} error=${getErrorMessage(err)}`);
      // CRITICAL: Never leak internal error details to the tool output
      return {
        success: false,
        output: `Tool execution failed: ${name}`,
      };
    }
  }

  getDestructiveTools(): string[] {
    return Array.from(this.tools.entries())
      .filter(([, tool]) => tool.isDestructive)
      .map(([name]) => name);
  }

  getParallelizableToolNames(): string[] {
    return Array.from(this.tools.entries())
      .filter(([, tool]) => this.executionPolicy.canRunInParallel(tool))
      .map(([name]) => name);
  }

  findByPartialName(partial: string): BaseTool[] {
    const lowerPartial = partial.toLowerCase();
    return Array.from(this.tools.values()).filter((tool) =>
      tool.name.toLowerCase().includes(lowerPartial)
    );
  }

  clear(): void {
    this.tools.clear();
    this.toolInfo.clear();
    this.allowedTools = null;
    this.disallowedTools.clear();
    this.deferredTools.clear();
    this.toolLoadOrder = [];
    this.schemaCache.clear();
    this.cacheVersion = 0;
  }

  get size(): number {
    return this.tools.size + this.deferredTools.size;
  }

  initializeMCP(projectDir: string): void {
    this.mcpManager = new MCPClientManager();
    this.mcpCommandHandler = new MCPCommandHandler(this, projectDir);
  }

  getMCPCommandHandler(): MCPCommandHandler | undefined {
    return this.mcpCommandHandler;
  }

  async handleMCPCommand(args: string[]): Promise<{ success: boolean; message: string }> {
    if (!this.mcpCommandHandler) {
      return {
        success: false,
        message: 'MCP not initialized. Call initializeMCP() first.',
      };
    }
    return this.mcpCommandHandler.handleCommand(args);
  }

  getMCPManager(): MCPClientManager | undefined {
    return this.mcpManager;
  }

  async cleanup(): Promise<void> {
    if (this.mcpCommandHandler) {
      await this.mcpCommandHandler.cleanup();
    }
  }

  isMCPTool(name: string): boolean {
    return name.startsWith('mcp__') || name.includes('__');
  }

  getStats(): { builtin: number; mcp: number; total: number } {
    const allTools = this.getToolNames();
    const mcpCount = allTools.filter((name) => this.isMCPTool(name)).length;
    return {
      builtin: allTools.length - mcpCount,
      mcp: mcpCount,
      total: allTools.length,
    };
  }

  searchTools(
    query: string,
    maxResults: number = 5
  ): Array<{ name: string; tool: BaseTool; score: number; reason: string }> {
    const queryLower = query.toLowerCase();
    const results: Array<{
      name: string;
      tool: BaseTool;
      score: number;
      reason: string;
    }> = [];

    for (const [name, info] of this.toolInfo) {
      if (!this.isToolAllowed(name)) continue;

      const nameScore = name.toLowerCase().includes(queryLower) ? 1.0 : 0.0;
      const descScore = info.tool.description.toLowerCase().includes(queryLower) ? 0.8 : 0.0;
      const tagScore = info.tags.some((t) => t.toLowerCase().includes(queryLower)) ? 0.6 : 0.0;
      const score = Math.max(nameScore, descScore, tagScore);

      if (score > 0) {
        let reason = '';
        if (nameScore === 1.0) reason = 'Name match';
        else if (descScore === 0.8) reason = 'Description match';
        else if (tagScore === 0.6) reason = 'Tag match';

        results.push({ name, tool: info.tool, score, reason });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  getToolsByCategory(
    category: string
  ): Array<{ name: string; tool: BaseTool; score: number; reason: string }> {
    const results: Array<{
      name: string;
      tool: BaseTool;
      score: number;
      reason: string;
    }> = [];

    for (const [name, info] of this.toolInfo) {
      if (info.category === category && this.isToolAllowed(name)) {
        results.push({
          name,
          tool: info.tool,
          score: 1.0,
          reason: `Category: ${category}`,
        });
      }
    }

    return results;
  }

  loadDeferredTool(name: string): boolean {
    const tool = this.deferredTools.get(name);
    if (tool) {
      this.tools.set(name, tool);
      this.deferredTools.delete(name);
      this.toolLoadOrder.push(name);
      return true;
    }
    return false;
  }

  hasDeferredTool(name: string): boolean {
    return this.deferredTools.has(name);
  }

  loadAllDeferredTools(): void {
    for (const [name, tool] of this.deferredTools) {
      this.tools.set(name, tool);
      this.toolLoadOrder.push(name);
    }
    this.deferredTools.clear();
  }

  getDeferredToolNames(): string[] {
    return Array.from(this.deferredTools.keys());
  }

  setToolResultSizeLimit(limit: number): void {
    this.toolResultSizeLimit = limit;
  }

  getToolResultSizeLimit(): number {
    return this.toolResultSizeLimit;
  }

  shouldPersistToolResult(toolName: string, resultSize: number): boolean {
    return resultSize > this.toolResultSizeLimit;
  }

  getToolLoadOrder(): string[] {
    return [...this.toolLoadOrder];
  }

  setToolLoadOrder(order: string[]): void {
    this.toolLoadOrder = order;
  }

  private categorizeTool(tool: BaseTool): string {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();

    if (
      name.includes('file') ||
      name.includes('read') ||
      name.includes('write') ||
      name.includes('edit')
    ) {
      return 'file-operations';
    } else if (name.includes('shell') || name.includes('execute') || name.includes('run')) {
      return 'system-operations';
    } else if (name.includes('search') || name.includes('grep') || name.includes('glob')) {
      return 'search-discovery';
    } else if (name.includes('market') || name.includes('trading') || name.includes('portfolio')) {
      return 'trading-finance';
    } else if (name.includes('wallet') || name.includes('blockchain') || name.includes('crypto')) {
      return 'blockchain-wallet';
    } else if (name.includes('mcp') || name.includes('defi')) {
      return 'defi-protocols';
    }
    return 'uncategorized';
  }

  private extractTags(tool: BaseTool): string[] {
    const tags: string[] = [];
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();

    if (name.includes('read') || description.includes('read')) tags.push('read');
    if (name.includes('write') || description.includes('write')) tags.push('write');
    if (name.includes('create') || description.includes('create')) tags.push('create');
    if (name.includes('delete') || description.includes('delete')) tags.push('delete');
    if (name.includes('search') || description.includes('search')) tags.push('search');
    if (name.includes('analyze') || description.includes('analyze')) tags.push('analyze');
    if (name.includes('market') || description.includes('market')) tags.push('market-data');
    if (name.includes('trading') || description.includes('trading')) tags.push('trading');
    if (name.includes('wallet') || description.includes('wallet')) tags.push('wallet');
    if (name.includes('defi') || description.includes('defi')) tags.push('defi');
    if (tool.isDestructive) tags.push('destructive');
    if (tool.requiresApproval) tags.push('requires-approval');

    return tags;
  }
}

export const globalToolRegistry = new ToolRegistry();
