/**
 * Tests for JsonRpcServer authentication and security.
 *
 * Uses mock AgentCore to test auth flow in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JsonRpcServer } from "./server";
import { JsonRpcErrorCodes } from "./types";
import { RpcMethods } from "./protocol";
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalManager } from '../../agent/core/goal-manager';
import { StateDb } from '../../state-db';

// ---------------------------------------------------------------------------
// Mock AgentCore
// ---------------------------------------------------------------------------

const mockAgentCore = {
  createSession: vi.fn().mockReturnValue({ id: "test-session", name: "Test", createdAt: new Date(), messageCount: 0, updatedAt: new Date() }),
  deleteSession: vi.fn().mockReturnValue(true),
  listSessions: vi.fn().mockReturnValue([]),
  getActiveSession: vi.fn().mockReturnValue({ id: "active-session", name: "Active", messages: [], messageCount: 0, createdAt: new Date(), updatedAt: new Date() }),
  switchSession: vi.fn().mockImplementation((id: string) => ({ id, name: "Switched", messages: [], messageCount: 0, createdAt: new Date(), updatedAt: new Date() })),
  restoreSession: vi.fn().mockImplementation((id: string, messages: unknown[]) => ({ id, name: 'Restored', messages, messageCount: messages.length, createdAt: new Date(), updatedAt: new Date() })),
  chatStream: vi.fn(),
  cancel: vi.fn(),
  compactConversation: vi.fn().mockReturnValue({ compacted: false, message: "", messageCount: 0 }),
  listAvailableTools: vi.fn().mockReturnValue([]),
  searchMemory: vi.fn().mockResolvedValue([]),
  writeMemory: vi.fn().mockResolvedValue({ id: 'mem-test', scope: 'test', kind: 'note' }),
  getMemoryStats: vi.fn().mockResolvedValue('Found 0 events in scope "agent_memory".'),
  getDecisionMetrics: vi.fn().mockReturnValue({ calls: 0, failures: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, byKind: {}, outcomes: {} }),
  delegate: vi.fn().mockResolvedValue({}),
  setToolPolicy: vi.fn(),
  setToolApprovalHandler: vi.fn(),
  setDelegateEventHandler: vi.fn(),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
  getState: vi.fn().mockReturnValue("idle"),
  getGoalManager: vi.fn(),
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
  let statePath: string;
  let goalStateDb: StateDb;
  let goalManager: GoalManager;

  beforeEach(() => {
    outputLines = [];
    statePath = mkdtempSync(join(tmpdir(), 'dynatrader-rpc-state-'));
    goalStateDb = new StateDb(join(statePath, 'goals.db'));
    goalManager = new GoalManager(goalStateDb);
    vi.mocked(mockAgentCore.getGoalManager).mockReturnValue(goalManager);
    outputStream = {
      write: vi.fn().mockImplementation((data: string) => { outputLines.push(data); }),
    };

    // Ensure no auth token by default
    delete process.env.DYNA_AUTH_TOKEN;

    server = new JsonRpcServer(
      { agent: mockAgentCore, statePath },
      undefined,
      outputStream as unknown as NodeJS.WriteStream,
    );
  });

  afterEach(() => {
    server.stop();
    goalStateDb.close();
    rmSync(statePath, { recursive: true, force: true });
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

  it('lists and returns terminal delegated tasks from StateDb after a server restart', async () => {
    const started = (server as any).handleAgentDelegateStart({ task: 'Inspect the runtime', agent: 'worker', sessionId: 'persist-session' });
    expect(started.task.status).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 0));

    server.stop();
    server = new JsonRpcServer({ agent: mockAgentCore, statePath }, undefined, outputStream as unknown as NodeJS.WriteStream);
    const listed = (server as any).handleAgentDelegateList({});
    expect(listed.tasks).toMatchObject([{ taskId: started.task.taskId, status: 'completed', agent: 'worker' }]);
    const status = (server as any).handleAgentDelegateStatus({ taskId: started.task.taskId, sessionId: 'persist-session' });
    expect(status.task).toMatchObject({ taskId: started.task.taskId, status: 'completed', task: 'Inspect the runtime' });
  });

  it('uses the active controller map only for cancellation and persists the terminal state', async () => {
    const originalDelegate = mockAgentCore.delegate;
    mockAgentCore.delegate = vi.fn(() => new Promise(() => {})) as never;
    const started = (server as any).handleAgentDelegateStart({ task: 'Long task', agent: 'worker', sessionId: 'cancel-session' });
    const cancelled = (server as any).handleAgentDelegateCancel({ taskId: started.task.taskId, sessionId: 'cancel-session' });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.task.status).toBe('cancelled');
    const listed = (server as any).handleAgentDelegateList({ sessionId: 'cancel-session' });
    expect(listed.tasks).toMatchObject([{ taskId: started.task.taskId, status: 'cancelled' }]);
    mockAgentCore.delegate = originalDelegate;
  });

  it('restores a UI transcript into the runtime session before future prompts', async () => {
    await sendLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: RpcMethods.SESSION_RESTORE,
      params: {
        sessionId: 'session-resume-2',
        messages: [
          { role: 'user', content: 'Earlier question', timestamp: '2026-09-29T10:00:00.000Z' },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      },
    }));

    expect(mockAgentCore.restoreSession).toHaveBeenCalledWith('session-resume-2', [
      { role: 'user', content: 'Earlier question', timestamp: new Date('2026-09-29T10:00:00.000Z') },
      expect.objectContaining({ role: 'assistant', content: 'Earlier answer', timestamp: expect.any(Date) }),
    ]);
    expect(lastResponse()?.['result']).toMatchObject({ sessionId: 'session-resume-2', messageCount: 2 });
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

  it('routes terminal memory search to the runtime memory store', async () => {
    vi.mocked(mockAgentCore.searchMemory).mockResolvedValue([
      { id: 'mem-a', score: 0.9, payload: { text: 'persisted choice' }, timestamp: new Date('2026-09-29T00:00:00Z') },
    ]);
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 20, method: RpcMethods.MEMORY_SEARCH, params: { scope: 'agent_memory', text: 'choice' } }));
    expect(vi.mocked(mockAgentCore.searchMemory)).toHaveBeenCalledWith('agent_memory', 'choice', undefined);
    expect(lastResponse()).toMatchObject({ id: 20, result: { count: 1, scope: 'agent_memory', query: 'choice' } });
  });

  it('rejects empty memory searches', async () => {
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 21, method: RpcMethods.MEMORY_SEARCH, params: { scope: 'agent_memory', text: ' ' } }));
    expect(lastResponse()).toMatchObject({ id: 21, error: { message: expect.stringContaining('requires scope and text') } });
  });

  it('validates goal.manage actions and set objectives', async () => {
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 40, method: RpcMethods.GOAL_MANAGE, params: { action: 'delete' } }));
    expect(lastResponse()).toMatchObject({ id: 40, error: { message: expect.stringContaining('requires action') } });
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 41, method: RpcMethods.GOAL_MANAGE, params: { action: 'set', objective: '  ' } }));
    expect(lastResponse()).toMatchObject({ id: 41, error: { message: expect.stringContaining('requires an objective') } });
  });

  it('manages goals through Core GoalManager and exposes persisted state after rehydration', async () => {
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 42, method: RpcMethods.GOAL_MANAGE, params: { action: 'set', objective: 'Ship the release' } }));
    const created = (lastResponse()?.result as { goal: { id: string; status: string } }).goal;
    expect(created).toMatchObject({ title: 'Ship the release', status: 'active' });

    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 43, method: RpcMethods.GOAL_MANAGE, params: { action: 'pause' } }));
    expect((lastResponse()?.result as { goal: { status: string } }).goal.status).toBe('paused');
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 44, method: RpcMethods.GOAL_MANAGE, params: { action: 'resume' } }));
    expect((lastResponse()?.result as { goal: { status: string } }).goal.status).toBe('active');

    // Simulate a new runtime GoalManager over the same SQLite file.
    server.stop();
    goalManager = GoalManager.fromDb(goalStateDb);
    vi.mocked(mockAgentCore.getGoalManager).mockReturnValue(goalManager);
    server = new JsonRpcServer({ agent: mockAgentCore, statePath }, undefined, outputStream as unknown as NodeJS.WriteStream);
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 45, method: RpcMethods.GOAL_MANAGE, params: { action: 'status' } }));
    expect(lastResponse()).toMatchObject({ id: 45, result: { goal: { id: created.id, status: 'active', title: 'Ship the release' } } });

    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 46, method: RpcMethods.GOAL_MANAGE, params: { action: 'complete' } }));
    expect((lastResponse()?.result as { goal: { status: string } }).goal.status).toBe('completed');
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 47, method: RpcMethods.GOAL_MANAGE, params: { action: 'list' } }));
    expect((lastResponse()?.result as { goals: Array<{ id: string }> }).goals.map((goal) => goal.id)).toContain(created.id);
    await sendLine(JSON.stringify({ jsonrpc: '2.0', id: 48, method: RpcMethods.GOAL_MANAGE, params: { action: 'clear' } }));
    expect(lastResponse()).toMatchObject({ id: 48, result: { changed: true, goal: null } });
  });
});
