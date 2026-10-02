/**
 * Tests for MCPRuntime
 *
 * These tests mock the transport layer to isolate runtime logic
 * (permissions, audit, blocking, server management).
 * Transport-level tests are in mcp-transport.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  MCPRuntime,
  MCPPermissionError,
  MCPBlockedToolError,
  MCPToolNotFoundError,
  type MCPServerConfig,
  type MCPToolDefinition,
} from "./mcp-runtime";
import { PermissionRuntime } from "@dyna/permission-runtime";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Mock transport implementations so tests don't need actual servers
// ---------------------------------------------------------------------------

vi.mock("./mcp-stdio-transport", () => ({
  StdioTransport: vi.fn().mockImplementation((_config) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation((request) => {
      const id = request.id ?? "mock";
      if (request.method === "tools/list") {
        return Promise.resolve({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo back input",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                },
              },
              {
                name: "get_time",
                description: "Get current time",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }
      if (request.method === "tools/call") {
        return Promise.resolve({
          jsonrpc: "2.0",
          id,
          result: {
            content: {
              tool: (request.params as Record<string, unknown>)?.name,
              status: "called",
              args: (request.params as Record<string, unknown>)?.arguments,
            },
          },
        });
      }
      return Promise.resolve({ jsonrpc: "2.0", id, result: {} });
    }),
    isConnected: vi.fn().mockReturnValue(true),
    onNotification: vi.fn(),
  })),
}));

vi.mock("./mcp-http-transport", () => ({
  HttpTransport: vi.fn().mockImplementation((_config) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation((request) => {
      const id = request.id ?? "mock";
      if (request.method === "tools/list") {
        return Promise.resolve({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo back input",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                },
              },
              {
                name: "get_time",
                description: "Get current time",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }
      if (request.method === "tools/call") {
        return Promise.resolve({
          jsonrpc: "2.0",
          id,
          result: {
            content: {
              tool: (request.params as Record<string, unknown>)?.name,
              status: "called",
              args: (request.params as Record<string, unknown>)?.arguments,
            },
          },
        });
      }
      return Promise.resolve({ jsonrpc: "2.0", id, result: {} });
    }),
    isConnected: vi.fn().mockReturnValue(true),
    onNotification: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-test-"));
}

/** Valid auth config - owner has '*' permissions and is in channel allowlists */
const validAuthConfig = {
  version: "1.0",
  owner: { id: "owner", role: "owner" as const },
  channels: {
    cli: { enabled: true, allowed_users: ["operator", "owner"] },
    web: { enabled: true, allowed_users: ["operator", "owner"] },
  },
  roles: {
    owner: { permissions: ["*"] },
    operator: { permissions: ["read_status", "run_backtest", "mcp:*"] },
  },
  approval_required_for: ["modify_risk_profile"],
  blocked_operations: ["withdraw_funds"],
};

/** Create a PermissionRuntime with the valid auth config */
function createPermissivePermissionRuntime(
  workspacePath: string,
): PermissionRuntime {
  return new PermissionRuntime(validAuthConfig, workspacePath);
}

/** Auth config that denies mcp calls */
const restrictiveAuthConfig = {
  version: "1.0",
  owner: { id: "restricted_owner", role: "owner" as const },
  channels: {
    cli: { enabled: true, allowed_users: ["restricted_owner"] },
  },
  roles: {
    owner: { permissions: ["read_status"] },
  },
  approval_required_for: [],
  blocked_operations: [],
};

const dummyToolDef: MCPToolDefinition = {
  name: "get_market_data",
  description: "Fetch market data for a symbol",
  inputSchema: {
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
  },
  riskLevel: "low",
  category: "market_data",
};

const highRiskToolDef: MCPToolDefinition = {
  name: "place_order",
  description: "Place a trade order",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      side: { type: "string", enum: ["buy", "sell"] },
      quantity: { type: "number" },
    },
    required: ["symbol", "side", "quantity"],
  },
  riskLevel: "critical",
  category: "trading",
};

const dummyHandler = vi.fn().mockResolvedValue({ result: "ok" });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCPRuntime", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    dummyHandler.mockClear();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Constructor & Mode
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("should create an MCPRuntime in client mode", () => {
      const runtime = new MCPRuntime({
        mode: "client",
        workspacePath: workspaceDir,
      });
      expect(runtime.getMode()).toBe("client");
    });

    it("should create an MCPRuntime in server mode", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });
      expect(runtime.getMode()).toBe("server");
    });

    it("should create an MCPRuntime in dual mode", () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });
      expect(runtime.getMode()).toBe("dual");
    });

    it("should block high-risk tools by default", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });
      const blocked = runtime.getBlockedTools();
      expect(blocked).toContain("place_order");
      expect(blocked).toContain("withdraw_funds");
      expect(blocked).toContain("update_credentials");
      expect(blocked).toContain("modify_api_keys");
    });

    it("should accept allowedHighRiskTools config to unblock specific tools", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        allowedHighRiskTools: ["place_order"],
      });
      expect(runtime.isBlocked("place_order")).toBe(false);
      expect(runtime.isBlocked("withdraw_funds")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Client Mode: Server Registration & Connection
  // -----------------------------------------------------------------------

  describe("client mode - server management", () => {
    it("should register an external MCP server", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      const serverConfig: MCPServerConfig = {
        name: "my-server",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      };

      await runtime.registerServer(serverConfig);
      const connections = runtime.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.name).toBe("my-server");
      expect(connections[0]!.connected).toBe(false);
    });

    it("should connect to registered servers and update status", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "server-1",
        transport: "stdio",
        command: "echo",
      });
      await runtime.registerServer({
        name: "server-2",
        transport: "http",
        url: "http://localhost:3001",
      });

      const connected = await runtime.connectServers();
      expect(connected).toHaveLength(2);
      expect(connected).toContain("server-1");
      expect(connected).toContain("server-2");

      const connections = runtime.getConnections();
      expect(connections.every((c) => c.connected)).toBe(true);
    });

    it("should discover tools from connected servers", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "data-server",
        transport: "http",
        url: "http://localhost:3002",
      });
      await runtime.connectServers();

      const tools = await runtime.discoverTools("data-server");
      expect(tools).toHaveLength(2);
      // With the new MCPToolRegistry, tool names are namespaced as mcp_<server>_<tool>
      expect(tools[0]!.name).toBe("mcp_data-server_echo");
      expect(tools[1]!.name).toBe("mcp_data-server_get_time");

      const clientTools = runtime.getClientTools();
      expect(clientTools).toHaveLength(2);
    });

    it("should throw when registering servers in server-only mode", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      await expect(
        runtime.registerServer({
          name: "ext",
          transport: "http",
          url: "http://localhost:3003",
        }),
      ).rejects.toThrow("server-only mode");
    });

    it("should throw when discovering from unknown server", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await expect(runtime.discoverTools("ghost")).rejects.toThrow("not found");
    });

    it("should throw when discovering from disconnected server", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "offline",
        transport: "http",
        url: "http://localhost:3004",
      });

      // Don't call connectServers - the transport won't be created
      await expect(runtime.discoverTools("offline")).rejects.toThrow(
        "not connected",
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3. Server Mode: Tool Registration & Discovery
  // -----------------------------------------------------------------------

  describe("server mode - tool registration", () => {
    it("should register a single server tool", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      runtime.registerTool(dummyToolDef, dummyHandler);
      const tools = runtime.getServerTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("get_market_data");
      expect(tools[0]!.riskLevel).toBe("low");
    });

    it("should register multiple tools at once", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      runtime.registerTools([
        {
          definition: {
            name: "tool_a",
            description: "Tool A",
            inputSchema: {},
            riskLevel: "low",
          },
          handler: dummyHandler,
        },
        {
          definition: {
            name: "tool_b",
            description: "Tool B",
            inputSchema: {},
            riskLevel: "medium",
          },
          handler: dummyHandler,
        },
      ]);

      expect(runtime.getServerTools()).toHaveLength(2);
    });

    it("should throw when registering tools in client-only mode", () => {
      const runtime = new MCPRuntime({
        mode: "client",
        workspacePath: workspaceDir,
      });

      expect(() =>
        runtime.registerTool(dummyToolDef, dummyHandler),
      ).toThrow("client-only mode");
    });

    it("should load server tools from config", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        serverTools: [dummyToolDef],
      });

      const tools = runtime.getServerTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("get_market_data");
    });
  });

  // -----------------------------------------------------------------------
  // 4. High-Risk Tool Blocking
  // -----------------------------------------------------------------------

  describe("high-risk tool blocking", () => {
    it("should block high-risk tools by default", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      expect(runtime.isBlocked("place_order")).toBe(true);
      expect(runtime.isBlocked("withdraw_funds")).toBe(true);
      expect(runtime.isBlocked("execute_trade")).toBe(true);
    });

    it("should allow low-risk tools by default", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      expect(runtime.isBlocked("get_market_data")).toBe(false);
      expect(runtime.isBlocked("echo")).toBe(false);
    });

    it("should dynamically block and unblock tools", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      expect(runtime.isBlocked("some_tool")).toBe(false);
      runtime.blockTool("some_tool");
      expect(runtime.isBlocked("some_tool")).toBe(true);

      runtime.unblockTool("some_tool");
      expect(runtime.isBlocked("some_tool")).toBe(false);
    });

    it("should allow high-risk tools via allowHighRiskTool", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      expect(runtime.isBlocked("place_order")).toBe(true);
      runtime.allowHighRiskTool("place_order");
      expect(runtime.isBlocked("place_order")).toBe(false);
    });

    it("should read extra blocked tools from config", () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        blockedTools: ["custom_risky_tool"],
      });

      expect(runtime.isBlocked("custom_risky_tool")).toBe(true);
      expect(runtime.isBlocked("place_order")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Server Tool Call Execution
  // -----------------------------------------------------------------------

  describe("server tool execution", () => {
    it("should execute a registered server tool successfully", async () => {
      const handler = vi
        .fn()
        .mockResolvedValue({ price: 45000, symbol: "BTC/USDT" });

      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      runtime.registerTool(
        {
          name: "get_price",
          description: "Get current price",
          inputSchema: {
            type: "object",
            properties: { symbol: { type: "string" } },
          },
          riskLevel: "low",
          category: "market_data",
        },
        handler,
      );

      // Use 'owner' which has '*' permissions and is in channel allowlists
      const result = await runtime.callTool("get_price", {
        caller: "owner",
        callerType: "user",
        args: { symbol: "BTC/USDT" },
        mode: "research",
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ price: 45000, symbol: "BTC/USDT" });
      expect(result.auditId).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(handler).toHaveBeenCalledWith({ symbol: "BTC/USDT" });
    });

    it("should handle server call via handleServerCall method", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      runtime.registerTool(dummyToolDef, dummyHandler);

      const result = await runtime.handleServerCall("get_market_data", {
        caller: "owner",
        callerType: "user",
        args: { symbol: "ETH/USDT" },
      });

      expect(result.success).toBe(true);
      expect(dummyHandler).toHaveBeenCalledWith({ symbol: "ETH/USDT" });
    });

    it("should reject blocked tool calls", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      runtime.registerTool(highRiskToolDef, dummyHandler);

      const result = await runtime.callTool("place_order", {
        caller: "owner",
        callerType: "user",
        args: { symbol: "BTC/USDT", side: "buy", quantity: 0.1 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("blocked by security policy");
    });

    it("should return error for non-existent tool", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      const result = await runtime.callTool("nonexistent_tool", {
        caller: "owner",
        callerType: "user",
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should return error when handler throws", async () => {
      const flakyHandler = vi
        .fn()
        .mockRejectedValue(new Error("Internal error"));

      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      runtime.registerTool(
        {
          name: "flaky",
          description: "This tool sometimes fails",
          inputSchema: {},
          riskLevel: "low",
        },
        flakyHandler,
      );

      const result = await runtime.callTool("flaky", {
        caller: "owner",
        callerType: "user",
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Internal error");
    });

    it("should reject call with insufficient permissions", async () => {
      const restrictedPerms = new PermissionRuntime(
        restrictiveAuthConfig,
        workspaceDir,
      );

      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: restrictedPerms,
      });

      runtime.registerTool(dummyToolDef, dummyHandler);

      const result = await runtime.callTool("get_market_data", {
        caller: "restricted_owner",
        callerType: "user",
        args: {},
      });

      // User has 'read_status' but not '*' or 'mcp:*'
      expect(result.success).toBe(false);
    });

    it("should record audit on successful call", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      runtime.registerTool(dummyToolDef, dummyHandler);

      const result = await runtime.callTool("get_market_data", {
        caller: "owner",
        callerType: "user",
        args: { symbol: "BTC/USDT" },
      });

      expect(result.success).toBe(true);
      expect(result.auditId).toBeTruthy();
      expect(result.auditId).toContain("mcp_server_get_market_data");
    });

    it("should record audit on failed call", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      // Register a tool that triggers an error
      const errorHandler = vi
        .fn()
        .mockRejectedValue(new Error("Something broke"));
      runtime.registerTool(
        {
          name: "error_tool",
          description: "Always fails",
          inputSchema: {},
          riskLevel: "low",
        },
        errorHandler,
      );

      const result = await runtime.callTool("error_tool", {
        caller: "owner",
        callerType: "user",
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.auditId).toBeTruthy();
      expect(result.auditId).toContain("mcp_server_error_tool");
    });

    it("should throw MCPToolNotFoundError on handleServerCall for unknown tool", async () => {
      const runtime = new MCPRuntime({
        mode: "server",
        workspacePath: workspaceDir,
      });

      await expect(
        runtime.handleServerCall("unknown_tool", {
          caller: "user",
          callerType: "user",
          args: {},
        }),
      ).rejects.toThrow(MCPToolNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Client Tool Call Execution
  // -----------------------------------------------------------------------

  describe("client tool execution", () => {
    it("should execute a client-discovered tool", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      // Simulate client-side tool discovery
      await runtime.registerServer({
        name: "ext-server",
        transport: "http",
        url: "http://localhost:3005",
      });
      await runtime.connectServers();
      await runtime.discoverTools("ext-server");

      const result = await runtime.callTool("mcp_ext-server_echo", {
        caller: "owner",
        callerType: "user",
        args: { message: "hello" },
        mode: "research",
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        tool: "echo",
        status: "called",
      });
    });

    it("should return error for non-existent client tool", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
        permissionRuntime: createPermissivePermissionRuntime(workspaceDir),
      });

      const result = await runtime.callTool("mcp_ext-server_nonexistent", {
        caller: "owner",
        callerType: "user",
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // 7. Dual Mode
  // -----------------------------------------------------------------------

  describe("dual mode", () => {
    it("should support both client and server operations", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      // Server side: register tools
      runtime.registerTool(dummyToolDef, dummyHandler);
      expect(runtime.getServerTools()).toHaveLength(1);

      // Client side: register and connect to server
      await runtime.registerServer({
        name: "ext",
        transport: "http",
        url: "http://localhost:3006",
      });
      await runtime.connectServers();

      const connections = runtime.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.connected).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Error types
  // -----------------------------------------------------------------------

  describe("error types", () => {
    it("should produce MCPPermissionError with tool name and reasons", () => {
      const err = new MCPPermissionError("place_order", [
        "No channel access",
        "Missing role",
      ]);
      expect(err.name).toBe("MCPPermissionError");
      expect(err.message).toContain("place_order");
      expect(err.message).toContain("No channel access");
    });

    it("should produce MCPBlockedToolError with tool name", () => {
      const err = new MCPBlockedToolError("withdraw_funds");
      expect(err.name).toBe("MCPBlockedToolError");
      expect(err.message).toContain("withdraw_funds");
      expect(err.message).toContain("blocked by security policy");
    });

    it("should produce MCPToolNotFoundError with tool name", () => {
      const err = new MCPToolNotFoundError("missing_tool");
      expect(err.name).toBe("MCPToolNotFoundError");
      expect(err.message).toContain("missing_tool");
    });
  });

  // -----------------------------------------------------------------------
  // 9. Server Status & Reconnect (new with real transport)
  // -----------------------------------------------------------------------

  describe("server status and reconnect", () => {
    it("should return server status with tool count", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "stats-server",
        transport: "http",
        url: "http://localhost:3007",
      });

      // Before connection
      const statusBefore = runtime.serverStatus("stats-server");
      expect(statusBefore).not.toBeNull();
      expect(statusBefore!.name).toBe("stats-server");
      expect(statusBefore!.connected).toBe(false);
      expect(statusBefore!.toolCount).toBe(0);

      // After connection + discovery
      await runtime.connectServers();
      await runtime.discoverTools("stats-server");

      const statusAfter = runtime.serverStatus("stats-server");
      expect(statusAfter).not.toBeNull();
      expect(statusAfter!.connected).toBe(true);
      expect(statusAfter!.toolCount).toBe(2);
    });

    it("should return null for unknown server", () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      expect(runtime.serverStatus("unknown")).toBeNull();
    });

    it("should support reconnectServer", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "reconnect-server",
        transport: "http",
        url: "http://localhost:3008",
      });

      await runtime.connectServers();
      expect(runtime.serverStatus("reconnect-server")!.connected).toBe(true);

      await runtime.reconnectServer("reconnect-server");
      expect(runtime.serverStatus("reconnect-server")!.connected).toBe(true);
    });

    it("should throw reconnectServer for unknown server", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await expect(runtime.reconnectServer("ghost")).rejects.toThrow(
        "not found",
      );
    });
  });

  // -----------------------------------------------------------------------
  // 10. Tool Filtering (include/exclude)
  // -----------------------------------------------------------------------

  describe("tool filtering", () => {
    it("should apply includeTools filter during discovery", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "filtered-server",
        transport: "http",
        url: "http://localhost:3009",
        includeTools: ["echo"],
      });

      await runtime.connectServers();
      const tools = await runtime.discoverTools("filtered-server");

      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("mcp_filtered-server_echo");
    });

    it("should apply excludeTools filter during discovery", async () => {
      const runtime = new MCPRuntime({
        mode: "dual",
        workspacePath: workspaceDir,
      });

      await runtime.registerServer({
        name: "exclude-server",
        transport: "http",
        url: "http://localhost:3010",
        excludeTools: ["get_time"],
      });

      await runtime.connectServers();
      const tools = await runtime.discoverTools("exclude-server");

      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("mcp_exclude-server_echo");
    });
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe("validateAuth", () => {
    let runtime: MCPRuntime;
    let warnSpy: MockInstance;

    beforeEach(() => {
      runtime = new MCPRuntime({ mode: "server", workspacePath: workspaceDir });
      warnSpy = vi.spyOn((runtime as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, "warn").mockImplementation(() => {});
      // Reset static flag between tests
      (MCPRuntime as unknown as { _authWarned: boolean })._authWarned = false;
      delete process.env.DYNA_AUTH_TOKEN;
    });

    afterEach(() => {
      warnSpy.mockRestore();
      delete process.env.DYNA_AUTH_TOKEN;
    });

    it("should allow calls when DYNA_AUTH_TOKEN is not set (backward compat)", () => {
      expect(() => runtime.validateAuth()).not.toThrow();
    });

    it("should warn once when DYNA_AUTH_TOKEN is not set", () => {
      runtime.validateAuth();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Second call should not warn again
      runtime.validateAuth();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("should reject missing auth header when token is set", () => {
      process.env.DYNA_AUTH_TOKEN = "secret123";
      expect(() => runtime.validateAuth()).toThrow("Authentication required");
    });

    it("should reject wrong token", () => {
      process.env.DYNA_AUTH_TOKEN = "secret123";
      expect(() => runtime.validateAuth("Bearer wrong")).toThrow("Invalid authentication token");
    });

    it("should reject malformed auth header format", () => {
      process.env.DYNA_AUTH_TOKEN = "secret123";
      expect(() => runtime.validateAuth("Basic dXNlcjpwYXNz")).toThrow("Invalid Authorization header format");
    });

    it("should accept valid Bearer token", () => {
      process.env.DYNA_AUTH_TOKEN = "secret123";
      expect(() => runtime.validateAuth("Bearer secret123")).not.toThrow();
    });

    it("should accept valid Bearer token with unusual casing", () => {
      process.env.DYNA_AUTH_TOKEN = "secret123";
      expect(() => runtime.validateAuth("bearer secret123")).not.toThrow();
    });

    it("should pass auth through handleServerCall with valid token", async () => {
      process.env.DYNA_AUTH_TOKEN = "valid-token";
      runtime.registerTool(dummyToolDef, dummyHandler);
      const result = await runtime.handleServerCall(
        "get_market_data",
        { caller: "test", callerType: "user", args: { symbol: "BTC" } },
        "Bearer valid-token",
      );
      expect(result.success).toBe(true);
    });

    it("should reject handleServerCall with invalid token", async () => {
      process.env.DYNA_AUTH_TOKEN = "valid-token";
      runtime.registerTool(dummyToolDef, dummyHandler);
      const result = await runtime.handleServerCall(
        "get_market_data",
        { caller: "test", callerType: "user", args: { symbol: "BTC" } },
        "Bearer wrong-token",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid authentication token");
    });

    it("should reject handleServerCall without auth header when token is set", async () => {
      process.env.DYNA_AUTH_TOKEN = "valid-token";
      runtime.registerTool(dummyToolDef, dummyHandler);
      const result = await runtime.handleServerCall(
        "get_market_data",
        { caller: "test", callerType: "user", args: { symbol: "BTC" } },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication required");
    });
  });
});