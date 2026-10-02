import { MCPClientManager } from "./client.js";
import { loadMCPConfig } from "../config/mcp-config.js";
import type { MCPServerConfig } from "../core/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { getErrorMessage } from "../utils/index.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * MCP Command Handler - Manages MCP server connections and commands
 * Following GitHub CLI patterns for clean, intuitive command structure
 */

export interface MCPStatus {
  server: string;
  status: "connected" | "disconnected" | "error";
  tools?: number;
  error?: string;
  lastConnected?: Date;
}

export interface MCPCommandResult {
  success: boolean;
  message: string;
  data?: any;
}

export class MCPCommandHandler {
  private manager: MCPClientManager;
  private connectedServers: Set<string> = new Set();
  private toolRegistry: ToolRegistry;
  private projectDir: string;

  constructor(toolRegistry: ToolRegistry, projectDir: string) {
    this.manager = new MCPClientManager();
    this.toolRegistry = toolRegistry;
    this.projectDir = projectDir;
  }

  /**
   * Handle /mcp commands - GitHub CLI style
   */
  async handleCommand(args: string[]): Promise<MCPCommandResult> {
    if (args.length === 0) {
      return this.showOverview();
    }

    const [command, ...commandArgs] = args;

    switch (command) {
      case "list":
        return this.listServers();
      case "connect":
        return this.connectServer(commandArgs[0]);
      case "disconnect":
        return this.disconnectServer(commandArgs[0]);
      case "status":
        return this.showStatus();
      case "tools":
        return this.listTools(commandArgs[0]);
      case "restart":
        return this.restartServer(commandArgs[0]);
      case "help":
        return this.showHelp(commandArgs[0]);
      default:
        // Try to interpret as server-specific command
        if (commandArgs.length > 0) {
          return this.handleServerCommand(
            command,
            commandArgs[0],
            commandArgs.slice(1),
          );
        }
        return {
          success: false,
          message: `Unknown command: /mcp ${command}. Use '/mcp help' for available commands.`,
        };
    }
  }

  /**
   * Show overview of MCP system
   */
  private async showOverview(): Promise<MCPCommandResult> {
    try {
      const config = await loadMCPConfig(this.projectDir);
      const serverCount = Object.keys(config).length;
      const connectedCount = this.connectedServers.size;

      return {
        success: true,
        message:
          `MCP System Overview\n${"=".repeat(50)}\n` +
          `Configured servers: ${serverCount}\n` +
          `Connected servers: ${connectedCount}\n` +
          `Available commands: /mcp [list|connect|disconnect|init|status|tools|restart|help]`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to load MCP configuration: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Initialize agents.md from references/ directory
   */
  private async initAgents(): Promise<MCPCommandResult> {
    try {
      const referencesDir = path.join(this.projectDir, "references");

      try {
        await fs.access(referencesDir);
      } catch {
        return {
          success: false,
          message: "references/ directory not found in project root",
        };
      }

      const entries = await fs.readdir(referencesDir, { withFileTypes: true });
      const agentsSections: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const agentsMdPath = path.join(
            referencesDir,
            entry.name,
            "AGENTS.md",
          );
          try {
            await fs.access(agentsMdPath);
            const content = await fs.readFile(agentsMdPath, "utf-8");
            agentsSections.push(`## ${entry.name}\n\n${content.trim()}\n`);
          } catch {
            // Skip if AGENTS.md doesn't exist
          }
        }
      }

      if (agentsSections.length === 0) {
        return {
          success: false,
          message: "No AGENTS.md files found in references/ subdirectories",
        };
      }

      const agentsMdContent = `# DynaMind Agent Instructions\n\nAggregated from reference projects.\n\n${agentsSections.join("\n---\n\n")}\n`;
      const outputPath = path.join(referencesDir, "agents.md");
      await fs.writeFile(outputPath, agentsMdContent, "utf-8");

      return {
        success: true,
        message: `Created ${outputPath} from ${agentsSections.length} reference(s)`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to initialize agents: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * List all configured MCP servers
   */
  private async listServers(): Promise<MCPCommandResult> {
    try {
      const config = await loadMCPConfig(this.projectDir);
      const servers = Object.entries(config);

      if (servers.length === 0) {
        return {
          success: true,
          message:
            "No MCP servers configured. Add servers to .dynamind/mcp.json",
        };
      }

      let output = "Configured MCP Servers:\n";
      output += "-".repeat(50) + "\n";

      for (const [name, serverConfig] of servers) {
        const isConnected = this.connectedServers.has(name);
        const status = isConnected ? "●" : "○";
        const command = serverConfig.command;
        const args = serverConfig.args?.join(" ") || "";

        output += `${status} ${name}\n`;
        output += `    Command: ${command} ${args}\n`;
        output += `    Status: ${isConnected ? "Connected" : "Disconnected"}\n\n`;
      }

      return {
        success: true,
        message: output,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to list servers: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Connect to a specific MCP server
   */
  private async connectServer(serverName: string): Promise<MCPCommandResult> {
    if (!serverName) {
      return {
        success: false,
        message: "Usage: /mcp connect <server-name>",
      };
    }

    if (this.connectedServers.has(serverName)) {
      return {
        success: false,
        message: `Server '${serverName}' is already connected`,
      };
    }

    try {
      const config = await loadMCPConfig(this.projectDir);
      const serverConfig = config[serverName] as MCPServerConfig;

      if (!serverConfig) {
        return {
          success: false,
          message: `Server '${serverName}' not found in configuration`,
        };
      }

      console.log(`Connecting to ${serverName}...`);
      await this.manager.connect(serverName, serverConfig, this.projectDir);

      const tools = await this.manager.getTools();

      // Register tools with the tool registry, tracking server affiliation
      for (const tool of tools) {
        this.toolRegistry.register(tool, false, serverName);
      }

      this.connectedServers.add(serverName);

      return {
        success: true,
        message: `Connected to ${serverName}\nLoaded ${tools.length} tools`,
        data: { toolsLoaded: tools.length },
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to connect to ${serverName}: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Disconnect from a specific MCP server
   */
  private async disconnectServer(
    serverName: string,
  ): Promise<MCPCommandResult> {
    if (!serverName) {
      return {
        success: false,
        message: "Usage: /mcp disconnect <server-name>",
      };
    }

    if (!this.connectedServers.has(serverName)) {
      return {
        success: false,
        message: `Server '${serverName}' is not connected`,
      };
    }

    try {
      await this.manager.disconnect(serverName);
      this.connectedServers.delete(serverName);

      // Remove all tools from this server from the registry
      const removedCount =
        this.toolRegistry.unregisterToolsForServer(serverName);
      if (removedCount > 0) {
        console.log(`Unregistered ${removedCount} tools from ${serverName}`);
      }

      return {
        success: true,
        message: `Disconnected from ${serverName}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to disconnect from ${serverName}: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Show detailed status of all MCP servers
   */
  private async showStatus(): Promise<MCPCommandResult> {
    try {
      const config = await loadMCPConfig(this.projectDir);
      const serverNames = Object.keys(config);

      if (serverNames.length === 0) {
        return {
          success: true,
          message: "No MCP servers configured",
        };
      }

      let output = "MCP Server Status:\n";
      output += "=".repeat(50) + "\n";

      for (const serverName of serverNames) {
        const isConnected = this.connectedServers.has(serverName);
        const status = isConnected ? "Connected" : "Disconnected";

        output += `${serverName}: ${status}\n`;

        if (isConnected) {
          try {
            const tools = await this.manager.getTools();
            const serverTools = tools.filter(
              (tool) => tool.getServerName() === serverName,
            );
            output += `  Tools: ${serverTools.length} available\n`;
          } catch (error) {
            output += `  Tools: Error retrieving tools\n`;
          }
        }
        output += "\n";
      }

      return {
        success: true,
        message: output,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to get status: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * List available tools from connected servers
   */
  private async listTools(serverName?: string): Promise<MCPCommandResult> {
    if (this.connectedServers.size === 0) {
      return {
        success: false,
        message: 'No MCP servers connected. Use "/mcp connect <server>" first.',
      };
    }

    try {
      const tools = await this.manager.getTools();
      let filteredTools = tools;

      if (serverName) {
        filteredTools = tools.filter(
          (tool) => tool.getServerName() === serverName,
        );
        if (filteredTools.length === 0) {
          return {
            success: false,
            message: `No tools found for server '${serverName}'`,
          };
        }
      }

      let output = `Available MCP Tools${serverName ? ` from ${serverName}` : ""}:\n`;
      output += "-".repeat(60) + "\n";

      // Group tools by server
      const toolsByServer = new Map<string, any[]>();
      for (const tool of filteredTools) {
        const server = tool.getServerName() || "Unknown";
        if (!toolsByServer.has(server)) {
          toolsByServer.set(server, []);
        }
        toolsByServer.get(server)!.push(tool);
      }

      for (const [server, serverTools] of toolsByServer) {
        output += `\n${server} (${serverTools.length} tools):\n`;
        for (const tool of serverTools) {
          const name = tool.definition?.name || tool.name || "Unknown";
          const desc =
            tool.definition?.description ||
            tool.description ||
            "No description";
          const shortDesc =
            desc.length > 60 ? desc.substring(0, 57) + "..." : desc;
          output += `  • ${name}: ${shortDesc}\n`;
        }
      }

      return {
        success: true,
        message: output,
        data: { totalTools: filteredTools.length },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to list tools: ${getErrorMessage(error)}`,
      };
    }
  }

  /**
   * Restart a server connection
   */
  private async restartServer(serverName: string): Promise<MCPCommandResult> {
    if (!serverName) {
      return {
        success: false,
        message: "Usage: /mcp restart <server-name>",
      };
    }

    const wasConnected = this.connectedServers.has(serverName);

    if (wasConnected) {
      const disconnectResult = await this.disconnectServer(serverName);
      if (!disconnectResult.success) {
        return disconnectResult;
      }
    }

    // Small delay before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return this.connectServer(serverName);
  }

  /**
   * Show help for MCP commands
   */
  private async showHelp(topic?: string): Promise<MCPCommandResult> {
    if (topic) {
      return this.showTopicHelp(topic);
    }

    return {
      success: true,
      message: `MCP Command Help - GitHub CLI Style
${"=".repeat(50)}

Available Commands:
  /mcp                    Show overview and quick status
  /mcp list              List all configured MCP servers
  /mcp connect <server>   Connect to a specific MCP server
  /mcp disconnect <server> Disconnect from a server
  /mcp init              Generate agents.md from references/
  /mcp status            Show detailed connection status
  /mcp tools [server]    List available tools (optionally from specific server)
  /mcp restart <server>  Restart server connection
  /mcp help [topic]      Show help for specific topic

Server-Specific Commands:
  /mcp <server> status   Show status for specific server

Examples:
  /mcp list                           # Show all configured servers
  /mcp connect hyperliquid            # Connect to Hyperliquid MCP
  /mcp tools hyperliquid              # Show Hyperliquid tools
  /mcp status                         # Show all server statuses
  /mcp disconnect hyperliquid         # Disconnect from Hyperliquid

Configuration:
  MCP servers are configured in .dynamind/mcp.json
  Each server needs a command, args, and optional environment variables.`,
    };
  }

  /**
   * Show help for specific topic
   */
  private async showTopicHelp(topic: string): Promise<MCPCommandResult> {
    const helpTexts: Record<string, string> = {
      connect: `Connecting to MCP Servers:

Usage: /mcp connect <server-name>

Connects to a configured MCP server and loads all its tools into the current session.

Examples:
  /mcp connect hyperliquid    # Connect to Hyperliquid trading server
  /mcp connect polymarket      # Connect to Polymarket prediction server

Notes:
  - Server must be configured in .dynamind/mcp.json
  - Tools become available immediately after connection
  - Multiple servers can be connected simultaneously`,

      list: `Listing MCP Servers:

Usage: /mcp list

Shows all configured MCP servers with their connection status.

Output shows:
  ● Connected servers
  ○ Disconnected servers
  Server command configuration`,

      tools: `Listing MCP Tools:

Usage: /mcp tools [server-name]

Shows available tools from connected MCP servers.

Examples:
  /mcp tools                 # Show tools from all connected servers
  /mcp tools hyperliquid    # Show only Hyperliquid tools

Tools are automatically available in AI conversations once connected.`,

      config: `MCP Configuration:

Configuration file: .dynamind/mcp.json

Format:
{
  "mcpServers": {
    "hyperliquid": {
      "command": "node",
      "args": ["./hyperliquid-mcp/dist/index.js"],
      "env": {
        "API_KEY": "your-key",
        "API_SECRET": "your-secret"
      }
    }
  }
}

Environment variables can be used with \${VAR_NAME} syntax.`,
    };

    const help = helpTexts[topic.toLowerCase()];
    if (help) {
      return {
        success: true,
        message: help,
      };
    }

    return {
      success: false,
      message: `No help available for topic: ${topic}. Available topics: connect, list, tools, config`,
    };
  }

  /**
   * Handle server-specific commands
   */
  private async handleServerCommand(
    serverName: string,
    action: string,
    args: string[],
  ): Promise<MCPCommandResult> {
    switch (action) {
      case "status":
        if (!this.connectedServers.has(serverName)) {
          return {
            success: false,
            message: `${serverName}: Disconnected`,
          };
        }
        try {
          const tools = await this.manager.getTools();
          const serverTools = tools.filter(
            (tool) => tool.getServerName() === serverName,
          );
          return {
            success: true,
            message: `${serverName}: Connected (${serverTools.length} tools available)`,
          };
        } catch (error) {
          return {
            success: false,
            message: `${serverName}: Error getting status - ${getErrorMessage(error)}`,
          };
        }
      default:
        return {
          success: false,
          message: `Unknown action for ${serverName}: ${action}. Use '/mcp help' for available commands.`,
        };
    }
  }

  /**
   * Clean up all connections
   */
  async cleanup(): Promise<void> {
    await this.manager.disconnectAll();
    this.connectedServers.clear();
  }
}

