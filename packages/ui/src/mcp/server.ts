import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolExecutionContext } from '../core/types.js';

/**
 * MCP server that exposes DynaMind tools to external AI clients.
 * This allows other assistants to use DynaMind runtime tools and analysis tools.
 */
export class DynamindMCPServer {
  private server: Server;
  private toolRegistry: ToolRegistry;
  private workingDirectory: string;

  constructor(toolRegistry: ToolRegistry, workingDirectory: string) {
    this.toolRegistry = toolRegistry;
    this.workingDirectory = workingDirectory;

    this.server = new Server(
      {
        name: 'dynamind-tools',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const definitions = this.toolRegistry.getToolDefinitions();

      return {
        tools: definitions.map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const context: ToolExecutionContext = {
        workingDirectory: this.workingDirectory,
        conversationId: 'mcp-server',
        isSubagent: false,
      };

      const result = await this.toolRegistry.execute(
        name,
        (args as Record<string, unknown>) || {},
        context
      );

      return {
        content: [
          {
            type: 'text',
            text: result.output,
          },
        ],
        isError: !result.success,
      };
    });
  }

  /**
   * Start the MCP server on stdio
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Log to stderr so it doesn't interfere with MCP protocol on stdout
    console.error('DynaMind tools MCP server started');
  }

  /**
   * Close the server
   */
  async close(): Promise<void> {
    await this.server.close();
  }
}

/**
 * Entry point for running DynaMind as an MCP server
 */
export async function runMCPServer(
  toolRegistry: ToolRegistry,
  workingDirectory: string
): Promise<void> {
  const server = new DynamindMCPServer(toolRegistry, workingDirectory);
  await server.start();

  // Keep running until terminated
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}

