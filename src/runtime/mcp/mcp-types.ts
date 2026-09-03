/**
 * MCP (Model Context Protocol) Types
 *
 * Extended types for MCP transport, server configuration, and tool definitions.
 */

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string; // for stdio
  args?: string[]; // for stdio
  url?: string; // for HTTP
  env?: Record<string, string>; // for stdio
  envFilter?: string[]; // security: only pass these env vars to child process
  includeTools?: string[]; // whitelist
  excludeTools?: string[]; // blacklist
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export type MCPRiskLevel = "low" | "medium" | "high" | "critical";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: MCPRiskLevel;
  category?: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Types
// ---------------------------------------------------------------------------

export interface MCPJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Transport Interface
// ---------------------------------------------------------------------------

export interface MCPTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(request: MCPJsonRpcRequest): Promise<MCPJsonRpcResponse>;
  isConnected(): boolean;
  onNotification(
    handler: (notification: { method: string; params?: unknown }) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Transport Events
// ---------------------------------------------------------------------------

export interface MCPTransportEventMap {
  connected: { serverName: string };
  disconnected: { serverName: string; reason?: string };
  error: { serverName: string; error: Error };
  notification: { serverName: string; method: string; params?: unknown };
  reconnecting: { serverName: string; attempt: number; maxRetries: number };
}