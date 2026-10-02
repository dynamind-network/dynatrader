/**
 * @dyna/mcp-runtime
 *
 * MCP (Model Context Protocol) runtime for Dyna-Trader.
 * Supports client mode (connect to external MCP servers) and
 * server mode (expose Dyna-Trader tools to MCP clients).
 *
 * Transport implementations:
 * - StdioTransport: child process stdin/stdout JSON-RPC
 * - HttpTransport: remote HTTP POST JSON-RPC with SSE notifications
 * - MCPToolRegistry: namespaced tool management with filtering
 */

export { MCPRuntime } from "./mcp-runtime";
export type {
  MCPRuntimeMode,
  RiskLevel,
  MCPToolDefinition,
  MCPServerConfig,
  MCPCallOptions,
  MCPCallResult,
  MCPRuntimeConfig,
} from "./mcp-runtime";
export {
  MCPPermissionError,
  MCPBlockedToolError,
  MCPToolNotFoundError,
} from "./mcp-runtime";

// Transport implementations
export { StdioTransport } from "./mcp-stdio-transport";
export { HttpTransport } from "./mcp-http-transport";
export { MCPToolRegistry } from "./mcp-tool-registry";

// Transport types
export type {
  MCPTransport,
  MCPJsonRpcRequest,
  MCPJsonRpcResponse,
  MCPTransportEventMap,
  MCPRiskLevel,
} from "./mcp-types";