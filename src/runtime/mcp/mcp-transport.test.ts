/**
 * Tests for MCP Transport implementations
 *
 * Tests StdioTransport, HttpTransport, and MCPToolRegistry in isolation.
 * Uses an echo MCP server for stdio tests and mocks fetch for HTTP tests.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { StdioTransport } from "./mcp-stdio-transport";
import { HttpTransport } from "./mcp-http-transport";
import { MCPToolRegistry } from "./mcp-tool-registry";
import type { MCPServerConfig, MCPJsonRpcRequest } from "./mcp-types";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Echo MCP Server Script
// ---------------------------------------------------------------------------

/**
 * Creates a temporary echo MCP server script.
 * Reads JSON-RPC from stdin, writes responses to stdout.
 * Supports: tools/list, tools/call, initialize, ping.
 */
function createEchoServerScript(): string {
  const scriptPath = path.join(
    os.tmpdir(),
    `mcp-echo-server-${Date.now()}.mjs`,
  );

  const script = `
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    const response = { jsonrpc: '2.0', id: request.id };

    if (request.method === 'initialize') {
      response.result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'echo-server', version: '1.0.0' } };
    } else if (request.method === 'tools/list') {
      response.result = {
        tools: [
          { name: 'echo', description: 'Echo back input', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
          { name: 'ping', description: 'Ping the server', inputSchema: { type: 'object', properties: {} } },
        ],
      };
    } else if (request.method === 'tools/call') {
      response.result = { content: request.params };
    } else if (request.method === 'ping') {
      response.result = {};
    } else {
      response.result = { echoed: request };
    }

    process.stdout.write(JSON.stringify(response) + '\\n');
  } catch {
    // Ignore malformed JSON
  }
});
`;

  fs.writeFileSync(scriptPath, script, "utf-8");
  return scriptPath;
}

// ---------------------------------------------------------------------------
// StdioTransport Tests
// ---------------------------------------------------------------------------

describe("StdioTransport", () => {
  let echoScriptPath: string;
  let config: MCPServerConfig;

  beforeAll(() => {
    echoScriptPath = createEchoServerScript();
  });

  afterAll(() => {
    try {
      fs.unlinkSync(echoScriptPath);
    } catch {
      // Cleanup temp file
    }
  });

  beforeEach(() => {
    config = {
      name: "echo-server",
      transport: "stdio",
      command: process.execPath, // Use current Node/Bun executable
      args: [echoScriptPath],
    };
  });

  it("should connect to a stdio MCP server", async () => {
    const transport = new StdioTransport(config);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    await transport.disconnect();
  });

  it("should send a request and receive a response", async () => {
    const transport = new StdioTransport(config);
    await transport.connect();

    const request: MCPJsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await transport.send(request);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    const result = response.result as { tools?: Array<unknown> };
    expect(result.tools).toBeInstanceOf(Array);
    expect(result.tools).toHaveLength(2);

    await transport.disconnect();
  });

  it("should call a tool and get a result", async () => {
    const transport = new StdioTransport(config);
    await transport.connect();

    const request: MCPJsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hello" } },
    };

    const response = await transport.send(request);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(2);
    expect(response.result).toBeDefined();

    await transport.disconnect();
  });

  it("should disconnect cleanly", async () => {
    const transport = new StdioTransport(config);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);

    await transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  it("should throw when sending before connecting", async () => {
    const transport = new StdioTransport(config);
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    ).rejects.toThrow("not connected");
  });

  it("should throw when command is missing", async () => {
    const badConfig: MCPServerConfig = {
      name: "bad",
      transport: "stdio",
    };
    const transport = new StdioTransport(badConfig);
    await expect(transport.connect()).rejects.toThrow(
      "requires a 'command'",
    );
  });

  it("should timeout on slow requests", async () => {
    const hangScriptPath = path.join(
      os.tmpdir(),
      `mcp-hang-server-${Date.now()}.mjs`,
    );
    const hangScript = `import * as readline from 'node:readline'; const rl = readline.createInterface({ input: process.stdin }); rl.on('line', () => {});`;
    fs.writeFileSync(hangScriptPath, hangScript, "utf-8");

    try {
      const hangConfig: MCPServerConfig = {
        name: "hang-server",
        transport: "stdio",
        command: process.execPath,
        args: [hangScriptPath],
      };

      const hangTransport = new StdioTransport(hangConfig, {
        timeoutMs: 500,
        maxRetries: 0,
      });

      await hangTransport.connect();

      await expect(
        hangTransport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      ).rejects.toThrow("timed out");

      await hangTransport.disconnect();
    } finally {
      try {
        fs.unlinkSync(hangScriptPath);
      } catch {
        // Cleanup
      }
    }
  });

  it("should handle notifications (register handler, no crash)", async () => {
    const transport = new StdioTransport(config);
    const handler = vi.fn();
    transport.onNotification(handler);

    await transport.connect();
    // No notifications expected from echo server, but handler shouldn't break
    await transport.disconnect();
    expect(handler).not.toHaveBeenCalled();
  });

  it("should apply envFilter security", async () => {
    process.env.__MCP_TEST_VAR = "should_be_visible";
    process.env.__MCP_SECRET_VAR = "should_be_hidden";

    const filteredConfig: MCPServerConfig = {
      name: "filtered-env",
      transport: "stdio",
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\\n');`,
      ],
      envFilter: ["__MCP_TEST_VAR", "PATH"],
    };

    const transport = new StdioTransport(filteredConfig);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    await transport.disconnect();

    delete process.env.__MCP_TEST_VAR;
    delete process.env.__MCP_SECRET_VAR;
  });
});

// ---------------------------------------------------------------------------
// HttpTransport Tests
// ---------------------------------------------------------------------------

describe("HttpTransport", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should connect and send a request via HTTP", async () => {
    let callCount = 0;

    globalThis.fetch = Object.assign(vi.fn().mockImplementation((url: string) => {
      callCount++;
      // First call is initialize
      if (callCount === 1 || url.toString().includes("/mcp")) {
        return Promise.resolve(
          createFetchResponse({
            jsonrpc: "2.0",
            id: "init",
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test-server", version: "1.0.0" },
            },
          }),
        );
      }
      // SSE endpoint returns 404 (expected fail)
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      );
    }), { preconnect: vi.fn() });

    const config: MCPServerConfig = {
      name: "http-test",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    await transport.connect();
    expect(transport.isConnected()).toBe(true);

    await transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  it("should send a tools/list request via HTTP", async () => {
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (callCount === 1 || !url.toString().includes("/sse")) {
        // First call is initialize, or subsequent tools/list calls
        const body = { tools: [
          { name: "echo", description: "Echo", inputSchema: {} },
          { name: "ping", description: "Ping", inputSchema: {} },
        ]};
        return Promise.resolve(
          createFetchResponse({
            jsonrpc: "2.0",
            id: callCount === 1 ? "init" : 1,
            result: callCount === 1
              ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1.0.0" } }
              : body,
          }),
        );
      }
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      );
    }) as any;

    const config: MCPServerConfig = {
      name: "http-test",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    await transport.connect();

    const request: MCPJsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const response = await transport.send(request);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toBeDefined();
    const result = response.result as { tools?: Array<unknown> };
    expect(result.tools).toBeInstanceOf(Array);
    expect(result.tools).toHaveLength(2);

    await transport.disconnect();
  });

  it("should handle connection errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("Connection refused"),
    ) as any;

    const config: MCPServerConfig = {
      name: "failing-test",
      transport: "http",
      url: "http://localhost:9999/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    await expect(transport.connect()).rejects.toThrow("Connection refused");
    expect(transport.isConnected()).toBe(false);
  });

  it("should handle non-200 HTTP responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Server error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    ) as any;

    const config: MCPServerConfig = {
      name: "error-test",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    await expect(transport.connect()).rejects.toThrow("HTTP 500");
  });

  it("should handle JSON-RPC errors in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createFetchResponse({
        jsonrpc: "2.0",
        id: "init",
        error: { code: -32601, message: "Method not found" },
      }),
    ) as any;

    const config: MCPServerConfig = {
      name: "error-test",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    await expect(transport.connect()).rejects.toThrow("JSON-RPC error");
  });

  it("should throw when URL is missing", async () => {
    const config: MCPServerConfig = {
      name: "no-url",
      transport: "http",
    };

    const transport = new HttpTransport(config);
    await expect(transport.connect()).rejects.toThrow("requires a 'url'");
  });

  it("should throw when sending before connecting", async () => {
    const config: MCPServerConfig = {
      name: "not-connected",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config);
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    ).rejects.toThrow("not connected");
  });

  it("should support notification handlers", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          createFetchResponse({
            jsonrpc: "2.0",
            id: "init",
            result: { status: "ok" },
          }),
        );
      }
      // SSE attempt returns 404
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" }),
      );
    }) as any;

    const config: MCPServerConfig = {
      name: "notif-test",
      transport: "http",
      url: "http://localhost:8080/mcp",
    };

    const transport = new HttpTransport(config, {
      healthCheckIntervalMs: 60000,
    });
    const handler = vi.fn();
    transport.onNotification(handler);

    await transport.connect();
    expect(handler).not.toHaveBeenCalled();
    expect(transport.isConnected()).toBe(true);

    await transport.disconnect();
  });
});

// ---------------------------------------------------------------------------
// MCPToolRegistry Tests
// ---------------------------------------------------------------------------

describe("MCPToolRegistry", () => {
  let registry: MCPToolRegistry;

  beforeEach(() => {
    registry = new MCPToolRegistry();
  });

  it("should namespace tools as mcp_<server>_<tool>", () => {
    const definitions = [
      { name: "echo", description: "Echo", inputSchema: {}, riskLevel: "low" as const },
      { name: "get_time", description: "Get time", inputSchema: {}, riskLevel: "low" as const },
    ];

    const result = registry.discoverTools("my-server", definitions);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("mcp_my-server_echo");
    expect(result[1]!.name).toBe("mcp_my-server_get_time");
  });

  it("should retrieve all tools from all servers", () => {
    registry.discoverTools("server-a", [
      { name: "tool1", description: "Tool 1", inputSchema: {}, riskLevel: "low" as const },
    ]);
    registry.discoverTools("server-b", [
      { name: "tool2", description: "Tool 2", inputSchema: {}, riskLevel: "medium" as const },
    ]);

    const all = registry.getAllTools();
    expect(all).toHaveLength(2);
    const names = all.map((t) => t.name).sort();
    expect(names).toEqual(["mcp_server-a_tool1", "mcp_server-b_tool2"]);
  });

  it("should get a specific tool by full name", () => {
    registry.discoverTools("s1", [
      { name: "my_tool", description: "My Tool", inputSchema: {}, riskLevel: "low" as const },
    ]);

    const tool = registry.getTool("mcp_s1_my_tool");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mcp_s1_my_tool");
    expect(tool!.description).toBe("My Tool");
  });

  it("should return undefined for unknown tool", () => {
    expect(registry.getTool("nonexistent")).toBeUndefined();
  });

  it("should resolve a namespaced name back to server and original name", () => {
    registry.discoverTools("finance", [
      { name: "get_price", description: "Get price", inputSchema: {}, riskLevel: "low" as const },
    ]);

    const resolved = registry.resolveName("mcp_finance_get_price");
    expect(resolved).not.toBeNull();
    expect(resolved!.serverName).toBe("finance");
    expect(resolved!.originalName).toBe("get_price");
  });

  it("should return null for unresolvable name", () => {
    expect(registry.resolveName("mcp_unknown_tool")).toBeNull();
  });

  it("should remove all tools for a server", () => {
    registry.discoverTools("s1", [
      { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
      { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
    ]);
    registry.discoverTools("s2", [
      { name: "c", description: "C", inputSchema: {}, riskLevel: "low" as const },
    ]);

    expect(registry.getAllTools()).toHaveLength(3);

    registry.removeServer("s1");
    expect(registry.getAllTools()).toHaveLength(1);
    expect(registry.getTool("mcp_s1_a")).toBeUndefined();
    expect(registry.getTool("mcp_s2_c")).toBeDefined();
  });

  it("should apply includeTools filter (whitelist)", () => {
    const result = registry.discoverTools(
      "s1",
      [
        { name: "keep_me", description: "Keep", inputSchema: {}, riskLevel: "low" as const },
        { name: "hide_me", description: "Hide", inputSchema: {}, riskLevel: "low" as const },
      ],
      { includeTools: ["keep_me"] },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("mcp_s1_keep_me");
    expect(registry.getTool("mcp_s1_hide_me")).toBeUndefined();
  });

  it("should apply excludeTools filter (blacklist)", () => {
    const result = registry.discoverTools(
      "s1",
      [
        { name: "safe", description: "Safe", inputSchema: {}, riskLevel: "low" as const },
        { name: "dangerous", description: "Dangerous", inputSchema: {}, riskLevel: "high" as const },
      ],
      { excludeTools: ["dangerous"] },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("mcp_s1_safe");
    expect(registry.getTool("mcp_s1_dangerous")).toBeUndefined();
  });

  it("should combine include and exclude filters", () => {
    const result = registry.discoverTools(
      "s1",
      [
        { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
        { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
        { name: "c", description: "C", inputSchema: {}, riskLevel: "low" as const },
      ],
      { includeTools: ["a", "b"], excludeTools: ["b"] },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("mcp_s1_a");
  });

  it("should re-discover tools (replace existing)", () => {
    registry.discoverTools("s1", [
      { name: "old", description: "Old", inputSchema: {}, riskLevel: "low" as const },
    ]);
    expect(registry.getAllTools()).toHaveLength(1);

    registry.discoverTools("s1", [
      { name: "new", description: "New", inputSchema: {}, riskLevel: "low" as const },
    ]);
    expect(registry.getAllTools()).toHaveLength(1);
    expect(registry.getTool("mcp_s1_new")).toBeDefined();
    expect(registry.getTool("mcp_s1_old")).toBeUndefined();
  });

  it("should get server list", () => {
    registry.discoverTools("s1", [
      { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
    ]);
    registry.discoverTools("s2", [
      { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
    ]);

    const servers = registry.getServers();
    expect(servers).toContain("s1");
    expect(servers).toContain("s2");
  });

  it("should get tools for a specific server", () => {
    registry.discoverTools("s1", [
      { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
      { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
    ]);
    registry.discoverTools("s2", [
      { name: "c", description: "C", inputSchema: {}, riskLevel: "low" as const },
    ]);

    const s1Tools = registry.getServerTools("s1");
    expect(s1Tools).toHaveLength(2);

    const s2Tools = registry.getServerTools("s2");
    expect(s2Tools).toHaveLength(1);
  });

  it("should clear all tools", () => {
    registry.discoverTools("s1", [
      { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
    ]);
    registry.discoverTools("s2", [
      { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
    ]);

    registry.clear();
    expect(registry.getAllTools()).toHaveLength(0);
    expect(registry.size).toBe(0);
  });

  it("should report correct size", () => {
    expect(registry.size).toBe(0);

    registry.discoverTools("s1", [
      { name: "a", description: "A", inputSchema: {}, riskLevel: "low" as const },
      { name: "b", description: "B", inputSchema: {}, riskLevel: "low" as const },
    ]);
    expect(registry.size).toBe(2);
  });

  it("should check tool existence with hasTool", () => {
    registry.discoverTools("s1", [
      { name: "exists", description: "Exists", inputSchema: {}, riskLevel: "low" as const },
    ]);

    expect(registry.hasTool("mcp_s1_exists")).toBe(true);
    expect(registry.hasTool("mcp_s1_missing")).toBe(false);
  });

  it("should return empty arrays for unknown servers", () => {
    expect(registry.getServerTools("ghost")).toEqual([]);
    expect(registry.getServers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: MCPRuntime with real transport (mocked)
// ---------------------------------------------------------------------------

describe("MCPRuntime transport integration", () => {
  let originalFetch: typeof globalThis.fetch;
  let workspaceDir: string;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (workspaceDir) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // cleanup
      }
    }
  });

  it("should route client tool calls through transport send", async () => {
    const { MCPRuntime } = await import("./mcp-runtime");
    const { PermissionRuntime } = await import("@dyna/permission-runtime");

    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-test-"));

    const validAuthConfig = {
      version: "1.0",
      owner: { id: "owner", role: "owner" as const },
      channels: { cli: { enabled: true, allowed_users: ["owner"] } },
      roles: { owner: { permissions: ["*"] } },
      approval_required_for: [],
      blocked_operations: [],
    };

    const permRuntime = new PermissionRuntime(validAuthConfig, workspaceDir);

    // Mock fetch for this test
    let toolListCalled = false;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.toString().includes("/sse")) {
        return Promise.resolve(
          new Response(null, { status: 404, statusText: "Not Found" }),
        );
      }
      if (!toolListCalled) {
        toolListCalled = true;
        return Promise.resolve(
          createFetchResponse({
            jsonrpc: "2.0",
            id: "init",
            result: { status: "ok" },
          }),
        );
      }
      return Promise.resolve(
        createFetchResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "echo", description: "Echo", inputSchema: {} },
            ],
          },
        }),
      );
    }) as any;

    const runtime = new MCPRuntime({
      mode: "dual",
      workspacePath: workspaceDir,
      permissionRuntime: permRuntime,
    });

    await runtime.registerServer({
      name: "test-server",
      transport: "http",
      url: "http://localhost:9000/mcp",
    });

    const connected = await runtime.connectServers();
    expect(connected).toContain("test-server");

    const tools = await runtime.discoverTools("test-server");
    expect(tools.length).toBeGreaterThan(0);

    const result = await runtime.callTool("mcp_test-server_echo", {
      caller: "owner",
      callerType: "user",
      args: { message: "integration test" },
    });

    expect(result.success).toBe(true);

    const status = runtime.serverStatus("test-server");
    expect(status).not.toBeNull();
    expect(status!.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: Create a mock fetch Response
// ---------------------------------------------------------------------------

function createFetchResponse(body: unknown): Response {
  const json = JSON.stringify(body);
  return new Response(json, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}