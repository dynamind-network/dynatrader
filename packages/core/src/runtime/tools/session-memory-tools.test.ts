import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import type { ToolCall, ToolResult, MemoryStore } from '@dyna/contracts';
import type { SessionManager, Session } from '@dyna/channels-core';
import type { MemoryStoreBackend, MemoryEvent } from '@dyna/memory-core';
import type { SpawnSubagentRuntimeLike } from './tools/spawn-subagent-tool';

import { SessionsListTool } from './tools/sessions-list-tool';
import { SessionsHistoryTool } from './tools/sessions-history-tool';
import { SessionsSendTool } from './tools/sessions-send-tool';
import { SpawnSubagentTool } from './tools/spawn-subagent-tool';
import { SessionStatusTool } from './tools/session-status-tool';
import { SessionSearchTool } from './tools/session-search-tool';
import { MemorySearchTool } from './tools/memory-search-tool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    tool: 'test',
    args: {},
    correlationId: uuid(),
    ...overrides,
  };
}

function createMockSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    userId: 'user-1',
    accountId: 'account-1',
    metadata: {
      userAgent: 'test-agent',
      ipAddress: '127.0.0.1',
      deviceType: 'desktop',
      permissions: ['read', 'write'],
      riskLevel: 'low',
    },
    state: {
      connected: true,
      lastMessage: now,
      messageCount: 5,
      errorCount: 0,
      blocked: false,
    },
    createdAt: now,
    lastActivity: now,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    ...overrides,
  };
}

function createMockSessionManager(sessions: Session[] = []): SessionManager {
  const sessionsMap = new Map(sessions.map((s) => [s.id, s]));
  return {
    getSession: vi.fn((id: string) => sessionsMap.get(id)),
    getAllSessions: vi.fn(() => Array.from(sessionsMap.values())),
    getActiveSessions: vi.fn(() =>
      Array.from(sessionsMap.values()).filter((s) => s.state.connected && !s.state.blocked),
    ),
    getSessionsByUser: vi.fn((userId: string) =>
      Array.from(sessionsMap.values()).filter((s) => s.userId === userId),
    ),
    createSession: vi.fn(),
    connectSession: vi.fn(),
    disconnectSession: vi.fn(),
    processMessage: vi.fn(),
    addError: vi.fn(),
    blockSession: vi.fn(),
    unblockSession: vi.fn(),
    pairSession: vi.fn(),
    unpairSession: vi.fn(),
    hasPermission: vi.fn(),
    cleanupExpiredSessions: vi.fn(),
    extendSession: vi.fn(),
    createDefaultSession: vi.fn(),
    validateSession: vi.fn(),
  } as unknown as SessionManager;
}

function createMockMemoryStore(results: Array<{ id: string; score: number; payload: unknown }> = []): MemoryStore {
  return {
    put: vi.fn(),
    search: vi.fn(async () => results),
    summarize: vi.fn(),
    compact: vi.fn(),
  } as unknown as MemoryStore;
}

function createMockMemoryBackend(events: MemoryEvent[] = []): MemoryStoreBackend {
  const eventsMap = new Map(events.map((e) => [e.id, e]));
  return {
    put: vi.fn(),
    get: vi.fn(async (id: string) => eventsMap.get(id) ?? null),
    search: vi.fn(),
    compact: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStoreBackend;
}

function createMockSubagentRuntime(): SpawnSubagentRuntimeLike {
  return {
    executeAgent: vi.fn(),
    initialize: vi.fn(),
    validateOutput: vi.fn(),
    completeExecution: vi.fn(),
  } as unknown as SpawnSubagentRuntimeLike;
}

// ---------------------------------------------------------------------------
// SessionsListTool
// ---------------------------------------------------------------------------

describe('SessionsListTool', () => {
  let tool: SessionsListTool;
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = createMockSessionManager([]);
    tool = new SessionsListTool(sessionManager);
  });

  it('should list all sessions', async () => {
    const sessions = [
      createMockSession({ id: 's1', userId: 'u1' }),
      createMockSession({ id: 's2', userId: 'u2', state: { ...createMockSession().state, connected: false } }),
    ];
    sessionManager = createMockSessionManager(sessions);
    tool = new SessionsListTool(sessionManager);

    const result = await tool.execute(makeCall({ tool: 'sessions_list', args: { filter: 'all' } }));

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect((data.sessions as Array<unknown>)).toHaveLength(2);
    expect(sessionManager.getAllSessions).toHaveBeenCalled();
  });

  it('should filter by active status', async () => {
    const activeSession = createMockSession({ id: 's1', userId: 'u1' });
    const inactiveSession = createMockSession({
      id: 's2',
      userId: 'u2',
      state: { ...createMockSession().state, connected: false },
    });
    sessionManager = createMockSessionManager([activeSession, inactiveSession]);
    tool = new SessionsListTool(sessionManager);

    const result = await tool.execute(makeCall({ tool: 'sessions_list', args: { filter: 'active' } }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    expect(sessionManager.getActiveSessions).toHaveBeenCalled();
  });

  it('should filter by blocked status', async () => {
    const blockedSession = createMockSession({
      id: 's1',
      state: { ...createMockSession().state, blocked: true, blockReason: 'Rate limited' },
    });
    const normalSession = createMockSession({ id: 's2' });
    sessionManager = createMockSessionManager([blockedSession, normalSession]);
    tool = new SessionsListTool(sessionManager);

    const result = await tool.execute(makeCall({ tool: 'sessions_list', args: { filter: 'blocked' } }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(1);
    const sessions = data.sessions as Array<Record<string, unknown>>;
    expect(sessions[0]?.blocked).toBe(true);
    expect(sessions[0]?.blockReason).toBe('Rate limited');
  });

  it('should handle empty sessions', async () => {
    const result = await tool.execute(makeCall({ tool: 'sessions_list', args: { filter: 'all' } }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect((data.sessions as Array<unknown>)).toHaveLength(0);
  });

  it('should default to filter=all when no filter given', async () => {
    const sessions = [createMockSession({ id: 's1' }), createMockSession({ id: 's2' })];
    sessionManager = createMockSessionManager(sessions);
    tool = new SessionsListTool(sessionManager);

    const result = await tool.execute(makeCall({ tool: 'sessions_list', args: {} }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect(data.filter).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// SessionsHistoryTool
// ---------------------------------------------------------------------------

describe('SessionsHistoryTool', () => {
  let tool: SessionsHistoryTool;
  let sessionManager: SessionManager;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    const session = createMockSession({ id: 'test-session' });
    sessionManager = createMockSessionManager([session]);
    memoryStore = createMockMemoryStore();
    tool = new SessionsHistoryTool(sessionManager, memoryStore);
  });

  it('should return session history', async () => {
    const now = new Date();
    const mockResults = [
      { id: 'msg-1', score: 0.9, payload: { sessionId: 'test-session', envelope: { text: 'Hello' }, timestamp: now.toISOString() } },
      { id: 'msg-2', score: 0.8, payload: { sessionId: 'test-session', envelope: { text: 'World' }, timestamp: now.toISOString() } },
    ];
    memoryStore = createMockMemoryStore(mockResults);
    tool = new SessionsHistoryTool(sessionManager, memoryStore);

    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: { sessionId: 'test-session', limit: 10 },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sessionId).toBe('test-session');
    expect(data.count).toBe(2);
    expect((data.messages as Array<unknown>)).toHaveLength(2);
    expect(memoryStore.search).toHaveBeenCalledWith({ scope: 'sessions', text: 'test-session', topK: 10 });
  });

  it('should handle empty history', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: { sessionId: 'test-session' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect((data.messages as Array<unknown>)).toHaveLength(0);
  });

  it('should reject missing sessionId', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: {},
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('should handle non-existent session', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: { sessionId: 'nonexistent' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should filter results by sessionId in payload', async () => {
    const now = new Date();
    const mockResults = [
      { id: 'msg-1', score: 0.9, payload: { sessionId: 'test-session', text: 'M1' } },
      { id: 'msg-2', score: 0.8, payload: { sessionId: 'other-session', text: 'M2' } },
      { id: 'msg-3', score: 0.7, payload: { sessionId: 'test-session', text: 'M3' } },
    ];
    memoryStore = createMockMemoryStore(mockResults);
    tool = new SessionsHistoryTool(sessionManager, memoryStore);

    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: { sessionId: 'test-session', limit: 50 },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(2);
  });

  it('should apply limit correctly', async () => {
    const now = new Date();
    const mockResults = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      score: 1.0 - i * 0.05,
      payload: { sessionId: 'test-session', text: `Message ${i}` },
    }));
    memoryStore = createMockMemoryStore(mockResults);
    tool = new SessionsHistoryTool(sessionManager, memoryStore);

    const result = await tool.execute(makeCall({
      tool: 'sessions_history',
      args: { sessionId: 'test-session', limit: 5 },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SessionsSendTool
// ---------------------------------------------------------------------------

describe('SessionsSendTool', () => {
  let tool: SessionsSendTool;
  let sessionManager: SessionManager;

  beforeEach(() => {
    const session = createMockSession({ id: 'test-session' });
    sessionManager = createMockSessionManager([session]);
    tool = new SessionsSendTool(sessionManager);
  });

  it('should send message to session', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: { sessionId: 'test-session', text: 'Hello, session!' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.delivered).toBe(true);
    expect(data.sessionId).toBe('test-session');
    expect(sessionManager.processMessage).toHaveBeenCalled();
  });

  it('should handle errors - missing sessionId', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: { text: 'Hello' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('should handle errors - missing text', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: { sessionId: 'test-session' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('text');
  });

  it('should handle non-existent session', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: { sessionId: 'nonexistent', text: 'Hello' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should handle blocked session', async () => {
    const blockedSession = createMockSession({
      id: 'blocked-session',
      state: { ...createMockSession().state, blocked: true, blockReason: 'Rate limited' },
    });
    sessionManager = createMockSessionManager([blockedSession]);
    tool = new SessionsSendTool(sessionManager);

    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: { sessionId: 'blocked-session', text: 'Hello' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked');
    expect(result.error).toContain('Rate limited');
  });

  it('should pass custom channel and senderId', async () => {
    const result = await tool.execute(makeCall({
      tool: 'sessions_send',
      args: {
        sessionId: 'test-session',
        text: 'Hello',
        channel: 'trading',
        senderId: 'risk-manager',
      },
    }));

    expect(result.success).toBe(true);
    expect(sessionManager.processMessage).toHaveBeenCalledWith(
      'test-session',
      expect.objectContaining({
        channel: 'trading',
        senderId: 'risk-manager',
        text: 'Hello',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// SpawnSubagentTool
// ---------------------------------------------------------------------------

describe('SpawnSubagentTool', () => {
  let tool: SpawnSubagentTool;
  let subagentRuntime: SpawnSubagentRuntimeLike;

  beforeEach(() => {
    subagentRuntime = createMockSubagentRuntime();
    tool = new SpawnSubagentTool(subagentRuntime);
  });

  it('should spawn a subagent', async () => {
    const mockContext = {
      agentName: 'research-agent',
      agentManifest: { name: 'research-agent' },
      mode: 'research' as const,
      input: { topic: 'test' },
      permissions: {
        allowedTools: ['web_fetch' as string, 'read' as string],
        allowedSkills: [] as string[],
        memoryAccess: { read: [] as string[], write: [] as string[] },
      },
    };
    (subagentRuntime.executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext);

    const result = await tool.execute(makeCall({
      tool: 'spawn_subagent',
      args: { agentName: 'research-agent', mode: 'research', input: { topic: 'test' } },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.agentName).toBe('research-agent');
    expect(data.mode).toBe('research');
    expect(subagentRuntime.executeAgent).toHaveBeenCalledWith('research-agent', 'research', { topic: 'test' });
  });

  it('should handle errors - missing agentName', async () => {
    const result = await tool.execute(makeCall({
      tool: 'spawn_subagent',
      args: { mode: 'research' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('agentName');
  });

  it('should handle errors - invalid mode', async () => {
    const result = await tool.execute(makeCall({
      tool: 'spawn_subagent',
      args: { agentName: 'test-agent', mode: 'invalid_mode' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid mode');
  });

  it('should handle subagent runtime errors', async () => {
    (subagentRuntime.executeAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Agent not found: test-agent'),
    );

    const result = await tool.execute(makeCall({
      tool: 'spawn_subagent',
      args: { agentName: 'test-agent', mode: 'research' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not found');
  });

  it('should default to research mode', async () => {
    const mockContext = {
      agentName: 'test-agent',
      agentManifest: { name: 'test-agent' },
      mode: 'research' as const,
      input: {},
      permissions: { allowedTools: [] as string[], allowedSkills: [] as string[], memoryAccess: { read: [] as string[], write: [] as string[] } },
    };
    (subagentRuntime.executeAgent as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext);

    const result = await tool.execute(makeCall({
      tool: 'spawn_subagent',
      args: { agentName: 'test-agent' },
    }));

    expect(result.success).toBe(true);
    expect(subagentRuntime.executeAgent).toHaveBeenCalledWith('test-agent', 'research', {});
  });
});

// ---------------------------------------------------------------------------
// SessionStatusTool
// ---------------------------------------------------------------------------

describe('SessionStatusTool', () => {
  let tool: SessionStatusTool;
  let sessionManager: SessionManager;

  beforeEach(() => {
    const session = createMockSession({ id: 'test-session', userId: 'user-1' });
    sessionManager = createMockSessionManager([session]);
    tool = new SessionStatusTool(sessionManager);
  });

  it('should return session status', async () => {
    const result = await tool.execute(makeCall({
      tool: 'session_status',
      args: { sessionId: 'test-session' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe('test-session');
    expect(data.userId).toBe('user-1');
    expect(data.status).toBe('active');
    expect(data.connected).toBe(true);
    expect(data.blocked).toBe(false);
  });

  it('should handle session not found', async () => {
    const result = await tool.execute(makeCall({
      tool: 'session_status',
      args: { sessionId: 'nonexistent' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should show blocked status', async () => {
    const blockedSession = createMockSession({
      id: 'blocked-id',
      state: { ...createMockSession().state, blocked: true, blockReason: 'Abuse detected' },
    });
    sessionManager = createMockSessionManager([blockedSession]);
    tool = new SessionStatusTool(sessionManager);

    const result = await tool.execute(makeCall({
      tool: 'session_status',
      args: { sessionId: 'blocked-id' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe('blocked');
    expect(data.blockReason).toBe('Abuse detected');
  });

  it('should show inactive status', async () => {
    const inactiveSession = createMockSession({
      id: 'inactive-id',
      state: { ...createMockSession().state, connected: false },
    });
    sessionManager = createMockSessionManager([inactiveSession]);
    tool = new SessionStatusTool(sessionManager);

    const result = await tool.execute(makeCall({
      tool: 'session_status',
      args: { sessionId: 'inactive-id' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe('inactive');
    expect(data.connected).toBe(false);
  });

  it('should reject missing sessionId', async () => {
    const result = await tool.execute(makeCall({
      tool: 'session_status',
      args: {},
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId');
  });
});

// ---------------------------------------------------------------------------
// SessionSearchTool
// ---------------------------------------------------------------------------

describe('SessionSearchTool', () => {
  let tool: SessionSearchTool;
  let sessionManager: SessionManager;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    const session = createMockSession({ id: 'session-a' });
    sessionManager = createMockSessionManager([session]);
    memoryStore = createMockMemoryStore();
    tool = new SessionSearchTool(memoryStore, sessionManager);
  });

  it('should discover matching turns across sessions', async () => {
    const now = new Date();
    const mockResults = [
      {
        id: 'msg-1',
        score: 0.98,
        timestamp: now,
        payload: {
          sessionId: 'session-a',
          kind: 'session_message',
          envelope: { text: 'We should watch BTC breakout levels.' },
          timestamp: now.toISOString(),
        },
      },
      {
        id: 'msg-2',
        score: 0.93,
        timestamp: now,
        payload: {
          sessionId: 'session-b',
          kind: 'session_message',
          envelope: { text: 'BTC breakout confirmed on 4h.' },
          timestamp: now.toISOString(),
        },
      },
    ];
    memoryStore = createMockMemoryStore(mockResults);
    tool = new SessionSearchTool(memoryStore, sessionManager);

    const result = await tool.execute(makeCall({
      tool: 'session_search',
      args: { query: 'BTC breakout', limit: 5 },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.mode).toBe('discover');
    expect(data.count).toBe(2);
    expect((data.results as Array<Record<string, unknown>>)[0]?.sessionId).toBe('session-a');
    expect(memoryStore.search).toHaveBeenCalledWith({ scope: 'sessions', text: 'BTC breakout', topK: 20 });
  });

  it('should scroll around a matched message within a session', async () => {
    const base = new Date('2026-07-13T15:00:00Z');
    const mockResults = Array.from({ length: 5 }, (_, index) => ({
      id: `msg-${index}`,
      score: 1 - index * 0.05,
      timestamp: new Date(base.getTime() + index * 1000),
      payload: {
        sessionId: 'session-a',
        kind: 'session_message',
        envelope: { text: `Message ${index}` },
        timestamp: new Date(base.getTime() + index * 1000).toISOString(),
      },
    }));
    memoryStore = createMockMemoryStore(mockResults);
    tool = new SessionSearchTool(memoryStore, sessionManager);

    const result = await tool.execute(makeCall({
      tool: 'session_search',
      args: { mode: 'scroll', sessionId: 'session-a', aroundMessageId: 'msg-2', window: 1 },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.mode).toBe('scroll');
    expect(data.count).toBe(3);
    expect(data.beforeCount).toBe(1);
    expect(data.afterCount).toBe(1);
    const messages = data.results as Array<Record<string, unknown>>;
    expect(messages[1]?.messageId).toBe('msg-2');
    expect(data.bookendStart).toBeDefined();
    expect(data.bookendEnd).toBeDefined();
  });

  it('should reject discovery without a query', async () => {
    const result = await tool.execute(makeCall({
      tool: 'session_search',
      args: {},
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('query');
  });
});

// ---------------------------------------------------------------------------
// MemorySearchTool
// ---------------------------------------------------------------------------

describe('MemorySearchTool', () => {
  let tool: MemorySearchTool;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    memoryStore = createMockMemoryStore();
    tool = new MemorySearchTool(memoryStore);
  });

  it('should search memory', async () => {
    const mockResults = [
      { id: 'evt-1', score: 0.95, payload: { text: 'Important trading signal' } },
      { id: 'evt-2', score: 0.85, payload: { text: 'Market analysis' } },
    ];
    memoryStore = createMockMemoryStore(mockResults);
    tool = new MemorySearchTool(memoryStore);

    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { scope: 'trading', text: 'signal' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect((data.results as Array<unknown>)).toHaveLength(2);
    expect(data.scope).toBe('trading');
    expect(data.query).toBe('signal');
    expect(memoryStore.search).toHaveBeenCalledWith({ scope: 'trading', text: 'signal', topK: 20 });
  });

  it('lists scoped stored records without requiring a phrase', async () => {
    const records = [
      { id: 'evt-1', score: 0, payload: { text: 'Stored decision' }, timestamp: new Date('2026-09-29T12:00:00.000Z') },
    ];
    memoryStore = createMockMemoryStore(records);
    tool = new MemorySearchTool(memoryStore);

    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { action: 'list', scope: 'trading', limit: 10 },
    }));

    expect(result.success).toBe(true);
    expect(memoryStore.search).toHaveBeenCalledWith({ scope: 'trading', text: '', topK: 11 });
    expect(result.data).toMatchObject({ action: 'list', scope: 'trading', count: 1, hasMore: false });
    expect((result.data as { records: Array<Record<string, unknown>> }).records[0]).toMatchObject({
      id: 'evt-1', scope: 'trading', payload: { text: 'Stored decision' },
    });
  });

  it('lists records across scopes through the backend filter API', async () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    const events: MemoryEvent[] = [
      { id: 'evt-1', scope: 'global', kind: 'decision', payload: { text: 'One' }, timestamp: now },
      { id: 'evt-2', scope: 'session-a', kind: 'learning', payload: { text: 'Two' }, timestamp: now },
      { id: 'evt-3', scope: 'session-b', kind: 'observation', payload: { text: 'Three' }, timestamp: now },
    ];
    const backend: MemoryStoreBackend = {
      put: vi.fn(),
      get: vi.fn(async (id: string) => events.find((event) => event.id === id) ?? null),
      search: vi.fn(async () => events.map((event) => ({ id: event.id, score: 0, payload: event.payload, timestamp: event.timestamp }))),
      compact: vi.fn(),
      close: vi.fn(),
    };
    memoryStore = {
      ...createMockMemoryStore(),
      getBackend: () => backend,
    } as MemoryStore;
    tool = new MemorySearchTool(memoryStore);

    const result = await tool.execute(makeCall({ tool: 'memory_search', args: { action: 'list', limit: 2 } }));

    expect(result.success).toBe(true);
    expect(backend.search).toHaveBeenCalledWith({ limit: 3 });
    expect(result.data).toMatchObject({ action: 'list', count: 2, scopes: ['global', 'session-a'], hasMore: true });
  });

  it('rejects unknown memory actions', async () => {
    const result = await tool.execute(makeCall({ tool: 'memory_search', args: { action: 'enumerate' } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('action');
  });

  it('does not claim all-scope inventory when the adapter lacks backend listing', async () => {
    const result = await tool.execute(makeCall({ tool: 'memory_search', args: { action: 'list' } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('memory backend');
    expect(memoryStore.search).not.toHaveBeenCalled();
  });

  it('should handle empty results', async () => {
    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { scope: 'unknown', text: 'nothing' },
    }));

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.count).toBe(0);
    expect((data.results as Array<unknown>)).toHaveLength(0);
  });

  it('should reject missing scope', async () => {
    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { text: 'test' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('scope');
  });

  it('should reject missing text', async () => {
    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { scope: 'test' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('text');
  });

  it('should respect topK parameter', async () => {
    await tool.execute(makeCall({
      tool: 'memory_search',
      args: { scope: 'test', text: 'query', topK: 5 },
    }));

    expect(memoryStore.search).toHaveBeenCalledWith({ scope: 'test', text: 'query', topK: 5 });
  });

  it('should handle search errors gracefully', async () => {
    (memoryStore.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Search failed'));

    const result = await tool.execute(makeCall({
      tool: 'memory_search',
      args: { scope: 'test', text: 'query' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Search failed');
  });
});
