/**
 * MCP (Model Context Protocol) Types
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequest {
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

export interface McpResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: number | string;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;    // For stdio transport
  args?: string[];     // For stdio transport
  url?: string;        // For SSE transport
  env?: Record<string, string>;
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
