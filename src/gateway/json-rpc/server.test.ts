/**
 * Tests for JsonRpcServer authentication and security.
 *
 * Uses mock AgentCore to test auth flow in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JsonRpcServer } from "./server";
import { JsonRpcErrorCodes } from "./types";
import { RpcMethods } from "./protocol";

// ---------------------------------------------------------------------------
// Mock AgentCore
// ---------------------------------------------------------------------------

const mockAgentCore = {
  createSession: vi.fn().mockReturnValue({ id: "test-session", name: "Test", createdAt: new Date(), messageCount: 0, updatedAt: new Date() }),
  deleteSession: vi.fn().mockReturnValue(true),
  listSessions: vi.fn().mockReturnValue([]),
  getActiveSession: vi.fn().mockReturnValue({ id: "active-session", name: "Active", messages: [], messageCount: 0, createdAt: new Date(), updatedAt: new Date() }),
  switchSession: vi.fn().mockImplementation((id: string) => ({ id, name: "Switched", messages: [], messageCount: 0, createdAt: new Date(), updatedAt: new Date() })),
  chatStream: vi.fn(),
  cancel: vi.fn(),
  compactConversation: vi.fn().mockReturnValue({ compacted: false, message: "", messageCount: 0 }),
  listAvailableTools: vi.fn().mockReturnValue([]),
  delegate: vi.fn().mockResolvedValue({}),
  setToolPolicy: vi.fn(),
  setToolApprovalHandler: vi.fn(),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
  getState: vi.fn().mockReturnValue("idle"),
  enterPlanMode: vi.fn(),
  exitPlanMode: vi.fn(),
  isPlanMode: vi.fn().mockReturnValue(false),
} as unknown as import("../../agent/core/agent-core").AgentCore;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JsonRpcServer auth", () => {
  let outputLines: string[];
  let outputStream: { write: (data: string) => void };
  let server: JsonRpcServer;

  beforeEach(() => {
    outputLines = [];
    outputStream = {
      write: vi.fn().mockImplementation((data: string) => { outputLines.push(data); }),
    };

    // Ensure no auth token by default
    delete process.env.DYNA_AUTH_TOKEN;

    server = new JsonRpcServer(
      { agent: mockAgentCore },
      undefined,
      outputStream as unknown as NodeJS.WriteStream,
    );
  });

  afterEach(() => {
    server.stop();
    delete process.env.DYNA_AUTH_TOKEN;
  });

  async function sendLine(line: string): Promise<void> {
    // Access the internal rl 'line' event handler
    await (server as unknown as { handleLine: (line: string) => Promise<void> }).handleLine(line);
  }

  function lastResponse(): Record<string, unknown> | null {
    if (outputLines.length === 0) return null;
    try {
      return JSON.parse(outputLines[outputLines.length - 1]!);
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // No auth configured (backward compatibility)
  // -----------------------------------------------------------------------

  it("denies pending tool approvals and clears their timeout when stopped", async () => {
    vi.useFakeTimers();
    try {
      const approval = (server as unknown as {
        requestToolApproval: (call: never, definition: { name: string; description: string }) => Promise<boolean>;
      }).requestToolApproval.call(server, {} as never, {
        name: "test-tool",
        description: "Test approval cleanup",
      });

      let decision: boolean | undefined;
      void approval.then((value) => { decision = value; });

      server.stop();
      await Promise.resolve();

      expect(decision).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should process requests without auth when DYNA_AUTH_TOKEN is not set", async () => {
    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.list",
      params: {},
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(1);
    // Should be a successful response (result present, no error)
    expect(response).not.toHaveProperty("error");
    expect(response).toHaveProperty("result");
  });

  // -----------------------------------------------------------------------
  // Auth required
  // -----------------------------------------------------------------------

  it("should reject requests without auth when DYNA_AUTH_TOKEN is set", async () => {
    process.env.DYNA_AUTH_TOKEN = "my-secret-token";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.list",
      params: {},
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(1);
    expect(response!.error).toBeDefined();
    expect((response!.error as Record<string, unknown>).code).toBe(JsonRpcErrorCodes.AUTH_ERROR);
  });

  it("should reject requests with wrong auth token", async () => {
    process.env.DYNA_AUTH_TOKEN = "my-secret-token";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.list",
      params: { auth: "wrong-token" },
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(2);
    expect(response!.error).toBeDefined();
    expect((response!.error as Record<string, unknown>).code).toBe(JsonRpcErrorCodes.AUTH_ERROR);
  });

  it("should accept requests with correct auth token in 'auth' param", async () => {
    process.env.DYNA_AUTH_TOKEN = "my-secret-token";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.list",
      params: { auth: "my-secret-token" },
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(3);
    expect(response).not.toHaveProperty("error");
    expect(response).toHaveProperty("result");
  });

  it("should accept requests with correct auth token in 'authorization' param", async () => {
    process.env.DYNA_AUTH_TOKEN = "my-secret-token";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "session.list",
      params: { authorization: "my-secret-token" },
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(4);
    expect(response).not.toHaveProperty("error");
    expect(response).toHaveProperty("result");
  });

  it("should accept requests with correct auth token in 'auth_token' param", async () => {
    process.env.DYNA_AUTH_TOKEN = "my-secret-token";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session.list",
      params: { auth_token: "my-secret-token" },
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(5);
    expect(response).not.toHaveProperty("error");
    expect(response).toHaveProperty("result");
  });

  it("should process regular requests after auth success", async () => {
    process.env.DYNA_AUTH_TOKEN = "token123";

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "agent.state",
      params: { auth: "token123" },
    }));

    const response = lastResponse();
    expect(response).not.toBeNull();
    expect(response!.id).toBe(10);
    expect(response).not.toHaveProperty("error");
    expect(response!.result).toBeDefined();
    expect((response!.result as Record<string, unknown>).state).toBe("idle");
  });

  it("delegates conversation.compact for the requested session", async () => {
    const compactResult = { compacted: true, message: "[Conversation Summary] retained task", messageCount: 3 };
    vi.mocked(mockAgentCore.compactConversation).mockClear();
    vi.mocked(mockAgentCore.compactConversation).mockReturnValue(compactResult);

    await sendLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: RpcMethods.CONVERSATION_COMPACT,
      params: { sessionId: "target-session" },
    }));

    expect(vi.mocked(mockAgentCore.compactConversation)).toHaveBeenCalledOnce();
    expect(vi.mocked(mockAgentCore.compactConversation)).toHaveBeenCalledWith("target-session");
    expect(lastResponse()).toMatchObject({ id: 11, result: compactResult });
  });

  it("rejects conversation.compact while a prompt is being processed", async () => {
    vi.mocked(mockAgentCore.compactConversation).mockClear();
    const state = server as unknown as { processing: boolean };
    const wasProcessing = state.processing;
    state.processing = true;

    try {
      await sendLine(JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: RpcMethods.CONVERSATION_COMPACT,
        params: {},
      }));

      const response = lastResponse();
      expect(response?.error).toMatchObject({
        code: JsonRpcErrorCodes.INTERNAL_ERROR,
        message: expect.stringContaining("Cannot compact while a prompt is being processed"),
      });
      expect(vi.mocked(mockAgentCore.compactConversation)).not.toHaveBeenCalled();
    } finally {
      state.processing = wasProcessing;
    }
  });
});
