import type {
  ToolCapabilities,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  RiskLevel,
} from "../core/types.js";

/**
 * Enumerates high‑level tool categories for intent‑aware matching.
 * Mirrors the approach used by Gemini‑CLI and Opencode.
 */
export enum ToolKind {
  Fetch = "fetch",
  Read = "read",
  Write = "write",
  Edit = "edit",
  Search = "search",
  Execute = "execute",
  Analyze = "analyze",
  Communicate = "communicate",
}

export abstract class BaseTool {
  abstract name: string;
  abstract description: string;
  abstract inputSchema: ToolDefinition["inputSchema"];
  abstract isDestructive: boolean;
  requiresApproval = false;
  readOnly = false;
  mutatesFiles = false;
  mutatesExternalState = false;
  canRunInParallel = false;
  riskLevel: RiskLevel = "low";

  /** Optional one‑line capability phrase for tool‑search matching */
  searchHint?: string;

  /** Categorization of tool effect */
  kind?: ToolKind;

  abstract execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  getCapabilities(): ToolCapabilities {
    return {
      readOnly: this.readOnly,
      mutatesFiles: this.mutatesFiles,
      mutatesExternalState: this.mutatesExternalState,
      canRunInParallel: this.canRunInParallel,
      riskLevel: this.riskLevel,
    };
  }

  async shouldConfirmExecute(
    _input: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<string | null> {
    return null;
  }

  protected validateInput(input: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const required = this.inputSchema.required || [];

    for (const field of required) {
      if (
        !(field in input) ||
        input[field] === undefined ||
        input[field] === null
      ) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }

  protected success(
    output: string,
    artifacts?: Record<string, unknown>,
  ): ToolResult {
    return { success: true, output, artifacts };
  }

  protected error(message: string): ToolResult {
    return { success: false, output: `Error: ${message}` };
  }

  protected handleError(err: unknown, prefix: string): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return this.error(`${prefix}: ${message}`);
  }

  protected async executeWithErrorHandling(
    handler: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      return await handler();
    } catch (err) {
      return this.handleError(err, "Execution failed");
    }
  }

  protected jsonSuccess(result: unknown): ToolResult {
    return this.success(JSON.stringify(result, null, 2));
  }
}

export class MCPTool extends BaseTool {
  name: string;
  description: string;
  inputSchema: ToolDefinition["inputSchema"];
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;

  private serverName: string;
  private executeRemote: (input: Record<string, unknown>) => Promise<unknown>;

  constructor(
    serverName: string,
    definition: ToolDefinition,
    executeRemote: (input: Record<string, unknown>) => Promise<unknown>,
  ) {
    super();
    this.serverName = serverName;
    this.name = `mcp__${serverName}__${definition.name}`;
    this.description = definition.description;
    this.inputSchema = definition.inputSchema;
    this.executeRemote = executeRemote;
  }

  getServerName(): string {
    return this.serverName;
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      const result = await this.executeRemote(input);
      return this.success(
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.error(`MCP tool ${this.name} failed: ${message}`);
    }
  }
}
