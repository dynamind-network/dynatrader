/**
 * MCPToolRegistry — Manages discovered tools from multiple MCP servers.
 *
 * Features:
 * - Applies include/exclude filters per server
 * - Namespaces tools as `mcp_<server>_<tool>` to avoid collisions
 * - Dynamic discovery and removal of tools per server
 */

import type { MCPToolDefinition } from "./mcp-types";

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

interface ServerToolEntry {
  serverName: string;
  originalName: string;
  namespacedName: string;
  definition: MCPToolDefinition;
}

// ---------------------------------------------------------------------------
// MCPToolRegistry
// ---------------------------------------------------------------------------

export class MCPToolRegistry {
  /** All registered tools indexed by server name */
  private serverTools: Map<string, Map<string, ServerToolEntry>> = new Map();

  /** All tools indexed by namespaced name for fast lookup */
  private toolsByName: Map<string, ServerToolEntry> = new Map();

  /**
   * Discover (register) tools from a specific server.
   * Applies include/exclude filters and namespaces the tools.
   *
   * @param serverName - The server name to namespace tools under
   * @param definitions - Raw tool definitions from the server
   * @param filters - Optional include/exclude filters
   * @returns The filtered and namespaced tool definitions that were registered
   */
  discoverTools(
    serverName: string,
    definitions: MCPToolDefinition[],
    filters?: {
      includeTools?: string[];
      excludeTools?: string[];
    },
  ): MCPToolDefinition[] {
    // Remove existing tools for this server (replace on re-discovery)
    this.removeServer(serverName);

    const serverMap = new Map<string, ServerToolEntry>();
    const result: MCPToolDefinition[] = [];

    for (const def of definitions) {
      // Apply include filter (whitelist)
      if (
        filters?.includeTools &&
        filters.includeTools.length > 0 &&
        !filters.includeTools.includes(def.name)
      ) {
        continue;
      }

      // Apply exclude filter (blacklist)
      if (
        filters?.excludeTools &&
        filters.excludeTools.length > 0 &&
        filters.excludeTools.includes(def.name)
      ) {
        continue;
      }

      const namespacedName = this.namespaceTool(serverName, def.name);

      const entry: ServerToolEntry = {
        serverName,
        originalName: def.name,
        namespacedName,
        definition: {
          ...def,
          name: namespacedName,
        },
      };

      serverMap.set(def.name, entry);
      this.toolsByName.set(namespacedName, entry);
      result.push(entry.definition);
    }

    this.serverTools.set(serverName, serverMap);
    return result;
  }

  /**
   * Get all namespaced tool definitions from all servers.
   */
  getAllTools(): MCPToolDefinition[] {
    return Array.from(this.toolsByName.values()).map((entry) => entry.definition);
  }

  /**
   * Get a specific tool by its full namespaced name.
   */
  getTool(fullName: string): MCPToolDefinition | undefined {
    return this.toolsByName.get(fullName)?.definition;
  }

  /**
   * Remove all tools for a given server.
   */
  removeServer(serverName: string): void {
    const serverMap = this.serverTools.get(serverName);
    if (serverMap) {
      for (const [, entry] of serverMap) {
        this.toolsByName.delete(entry.namespacedName);
      }
      this.serverTools.delete(serverName);
    }
  }

  /**
   * Get all tools for a specific server (by their original names).
   */
  getServerTools(serverName: string): MCPToolDefinition[] {
    const serverMap = this.serverTools.get(serverName);
    if (!serverMap) return [];
    return Array.from(serverMap.values()).map((entry) => entry.definition);
  }

  /**
   * Check if a tool exists by its full namespaced name.
   */
  hasTool(fullName: string): boolean {
    return this.toolsByName.has(fullName);
  }

  /**
   * Get the count of registered tools.
   */
  get size(): number {
    return this.toolsByName.size;
  }

  /**
   * Get the list of server names that have tools registered.
   */
  getServers(): string[] {
    return Array.from(this.serverTools.keys());
  }

  /**
   * Clear all tools from the registry.
   */
  clear(): void {
    this.serverTools.clear();
    this.toolsByName.clear();
  }

  /**
   * Resolve the server and original tool name from a namespaced tool name.
   * Returns null if the tool is not found.
   */
  resolveName(fullName: string): { serverName: string; originalName: string } | null {
    const entry = this.toolsByName.get(fullName);
    if (!entry) return null;
    return {
      serverName: entry.serverName,
      originalName: entry.originalName,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Create a namespaced tool name: `mcp_<server>_<tool>`
   */
  private namespaceTool(serverName: string, toolName: string): string {
    return `mcp_${serverName}_${toolName}`;
  }
}