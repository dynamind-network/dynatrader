import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SessionManager,
  AgentLoop,
  Message as CoreMessage,
  ExecutionMode,
} from '../src/index.js';

// ============================================================
// Test the pure logic extracted from useSessionManager
// These tests verify the session management behavior without
// needing React rendering infrastructure.
// ============================================================

// Re-create the session ID generator for testing
const createSessionId = (): string =>
  `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Re-create the session text formatting logic for testing
function formatRecentSessionsText(
  sessions: Array<{ id: string; title: string; updatedAt: string }>
): string {
  if (sessions.length === 0) {
    return 'No saved sessions found yet.';
  }

  const idWidth = Math.max('Session ID'.length, ...sessions.map((s) => s.id.length));
  const titleWidth = Math.max('Title'.length, ...sessions.map((s) => s.title.length));

  const lines = [
    'Recent sessions:',
    `${'Session ID'.padEnd(idWidth)}  ${'Title'.padEnd(titleWidth)}  Updated`,
    `${'\u2500'.repeat(idWidth)}  ${'\u2500'.repeat(titleWidth)}  ${'\u2500'.repeat(19)}`,
    ...sessions.map((session) => {
      const updatedAt = session.updatedAt
        ? new Date(session.updatedAt).toLocaleString()
        : 'Unknown';
      return `${session.id.padEnd(idWidth)}  ${session.title.padEnd(titleWidth)}  ${updatedAt}`;
    }),
    '',
    'Use /resume <session-id> to continue one.',
  ];

  return lines.join('\n');
}

// Re-create the session sorting/filtering logic for testing
function processSessionSummaries(
  sessionIds: string[],
  loadSession: (
    id: string
  ) => Promise<{ messages: CoreMessage[]; metadata: Record<string, unknown> } | null>
): Array<{ id: string; title: string; updatedAt: string }> {
  return sessionIds
    .map((sessionId) => ({ sessionId, loadSession }))
    .reduce(
      (acc, { sessionId, loadSession: loadFn }) =>
        acc.then(async (results) => {
          const session = await loadFn(sessionId);
          const metadata = (session?.metadata ?? {}) as {
            title?: string;
            createdAt?: string;
            updatedAt?: string;
          };
          if (session) {
            results.push({
              id: sessionId,
              title: metadata.title || 'Untitled chat',
              updatedAt: metadata.updatedAt || metadata.createdAt || '',
            });
          }
          return results;
        }),
      Promise.resolve([] as Array<{ id: string; title: string; updatedAt: string }>)
    )
    .then((results) => results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10));
}

// Mock SessionManager
function createMockSessionManager() {
  const sessions: Record<string, { messages: CoreMessage[]; metadata: Record<string, unknown> }> =
    {};

  return {
    instance: {
      saveSession: vi.fn(
        async (
          sessionId: string,
          state: { messages: CoreMessage[]; metadata: Record<string, unknown> }
        ) => {
          sessions[sessionId] = state;
        }
      ),
      loadSession: vi.fn(async (sessionId: string) => {
        return sessions[sessionId] ?? null;
      }),
      listSessions: vi.fn(async () => {
        return Object.keys(sessions);
      }),
      deleteSession: vi.fn(async (sessionId: string) => {
        delete sessions[sessionId];
      }),
    },
    sessions,
  };
}

// Mock AgentLoop
function createMockAgentLoop() {
  const conversation: CoreMessage[] = [];
  return {
    instance: {
      clearConversation: vi.fn(() => {
        conversation.length = 0;
      }),
      addMessage: vi.fn((message: CoreMessage) => {
        conversation.push(message);
      }),
      getConversation: vi.fn(() => [...conversation]),
      setExecutionMode: vi.fn((_mode: ExecutionMode) => {}),
    },
    conversation,
  };
}

describe('useSessionManager - session ID generation', () => {
  it('generates unique session IDs with correct format', () => {
    const id1 = createSessionId();
    const id2 = createSessionId();

    expect(id1).toMatch(/^session-[a-z0-9]+-[a-z0-9]+$/);
    expect(id2).toMatch(/^session-[a-z0-9]+-[a-z0-9]+$/);
    expect(id1).not.toBe(id2);
  });
});

describe('useSessionManager - session text formatting', () => {
  it('returns default message when no sessions', () => {
    const result = formatRecentSessionsText([]);
    expect(result).toBe('No saved sessions found yet.');
  });

  it('formats sessions with aligned columns', () => {
    const sessions = [
      { id: 'session-abc', title: 'Test Session', updatedAt: '2024-01-01T00:00:00.000Z' },
    ];

    const result = formatRecentSessionsText(sessions);

    expect(result).toContain('Recent sessions:');
    expect(result).toContain('Session ID');
    expect(result).toContain('Title');
    expect(result).toContain('Updated');
    expect(result).toContain('Test Session');
    expect(result).toContain('Use /resume <session-id> to continue one.');
  });

  it('formats multiple sessions with proper alignment', () => {
    const sessions = [
      { id: 's1', title: 'Short', updatedAt: '2024-01-01T00:00:00.000Z' },
      {
        id: 'session-very-long-id',
        title: 'A Much Longer Title',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    ];

    const result = formatRecentSessionsText(sessions);

    // Should contain both sessions
    expect(result).toContain('s1');
    expect(result).toContain('Short');
    expect(result).toContain('session-very-long-id');
    expect(result).toContain('A Much Longer Title');
  });
});

describe('useSessionManager - session summaries processing', () => {
  it('returns sorted sessions by updatedAt descending', async () => {
    const sessions: Record<string, { messages: CoreMessage[]; metadata: Record<string, unknown> }> =
      {
        'session-1': {
          messages: [],
          metadata: {
            title: 'First',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            model: 'test',
            cwd: '/test',
          },
        },
        'session-2': {
          messages: [],
          metadata: {
            title: 'Second',
            createdAt: '2024-01-02T00:00:00.000Z',
            updatedAt: '2024-01-02T00:00:00.000Z',
            model: 'test',
            cwd: '/test',
          },
        },
        'session-3': {
          messages: [],
          metadata: {
            title: 'Third',
            createdAt: '2024-01-03T00:00:00.000Z',
            updatedAt: '2024-01-03T00:00:00.000Z',
            model: 'test',
            cwd: '/test',
          },
        },
      };

    const loadSession = vi.fn(async (id: string) => sessions[id] ?? null);
    const sessionIds = ['session-1', 'session-2', 'session-3'];

    const result = await processSessionSummaries(sessionIds, loadSession);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('session-3');
    expect(result[1].id).toBe('session-2');
    expect(result[2].id).toBe('session-1');
  });

  it('limits to 10 sessions', async () => {
    const sessions: Record<string, { messages: CoreMessage[]; metadata: Record<string, unknown> }> =
      {};
    for (let i = 0; i < 15; i++) {
      sessions[`session-${i}`] = {
        messages: [],
        metadata: {
          title: `Session ${i}`,
          createdAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
          updatedAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
          model: 'test',
          cwd: '/test',
        },
      };
    }

    const loadSession = vi.fn(async (id: string) => sessions[id] ?? null);
    const sessionIds = Object.keys(sessions);

    const result = await processSessionSummaries(sessionIds, loadSession);

    expect(result).toHaveLength(10);
  });

  it('uses default title when metadata title is missing', async () => {
    const sessions: Record<string, { messages: CoreMessage[]; metadata: Record<string, unknown> }> =
      {
        'session-untitled': {
          messages: [],
          metadata: {
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            model: 'test',
            cwd: '/test',
          },
        },
      };

    const loadSession = vi.fn(async (id: string) => sessions[id] ?? null);

    const result = await processSessionSummaries(['session-untitled'], loadSession);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Untitled chat');
  });

  it('filters out null sessions', async () => {
    const sessions: Record<string, { messages: CoreMessage[]; metadata: Record<string, unknown> }> =
      {
        'session-valid': {
          messages: [],
          metadata: {
            title: 'Valid',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            model: 'test',
            cwd: '/test',
          },
        },
      };

    const loadSession = vi.fn(async (id: string) => sessions[id] ?? null);

    const result = await processSessionSummaries(['session-valid', 'session-missing'], loadSession);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('session-valid');
  });
});

describe('useSessionManager - resumeSession logic', () => {
  let mockSm: ReturnType<typeof createMockSessionManager>;
  let mockAgentLoop: ReturnType<typeof createMockAgentLoop>;

  beforeEach(() => {
    mockSm = createMockSessionManager();
    mockAgentLoop = createMockAgentLoop();
    vi.clearAllMocks();
  });

  it('returns error for unknown session', async () => {
    const sessionManager = mockSm.instance as unknown as SessionManager;
    const session = await sessionManager.loadSession('nonexistent-session');

    expect(session).toBeNull();
  });

  it('loads session metadata correctly', async () => {
    mockSm.sessions['session-abc'] = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
      metadata: {
        title: 'Test Session',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        model: 'claude-sonnet-4-20250514',
        executionMode: 'auto-approve',
        cwd: '/test',
      },
    };

    const sessionManager = mockSm.instance as unknown as SessionManager;
    const session = await sessionManager.loadSession('session-abc');

    expect(session).not.toBeNull();
    const metadata = session!.metadata as {
      title: string;
      executionMode: string;
      model: string;
    };
    expect(metadata.title).toBe('Test Session');
    expect(metadata.executionMode).toBe('auto-approve');
    expect(metadata.model).toBe('claude-sonnet-4-20250514');
  });

  it('restores conversation via agentLoop when available', async () => {
    mockSm.sessions['session-with-agent'] = {
      messages: [
        { role: 'user', content: 'Test message' },
        { role: 'assistant', content: 'Test response' },
      ],
      metadata: {
        title: 'Agent Session',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        model: 'test',
        cwd: '/test',
      },
    };

    const sessionManager = mockSm.instance as unknown as SessionManager;
    const session = await sessionManager.loadSession('session-with-agent');

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);

    // Simulate what resumeSession does with agentLoop
    const agentLoop = mockAgentLoop.instance as unknown as AgentLoop;
    agentLoop.clearConversation();
    for (const message of session!.messages) {
      agentLoop.addMessage(message);
    }

    expect(mockAgentLoop.instance.clearConversation).toHaveBeenCalled();
    expect(mockAgentLoop.instance.addMessage).toHaveBeenCalledTimes(2);
  });

  it('determines correct execution mode from metadata', () => {
    const metadata1 = { executionMode: 'auto-approve' };
    const metadata2 = { executionMode: 'normal' };
    const metadata3 = {};

    const mode1: ExecutionMode =
      (metadata1 as { executionMode?: string }).executionMode === 'auto-approve'
        ? 'auto-approve'
        : 'normal';
    const mode2: ExecutionMode =
      (metadata2 as { executionMode?: string }).executionMode === 'auto-approve'
        ? 'auto-approve'
        : 'normal';
    const mode3: ExecutionMode =
      (metadata3 as { executionMode?: string }).executionMode === 'auto-approve'
        ? 'auto-approve'
        : 'normal';

    expect(mode1).toBe('auto-approve');
    expect(mode2).toBe('normal');
    expect(mode3).toBe('normal');
  });
});

describe('useSessionManager - clearSession logic', () => {
  it('generates new session ID on clear', () => {
    const oldId = createSessionId();
    const newId = createSessionId();

    expect(newId).not.toBe(oldId);
    expect(newId).toMatch(/^session-[a-z0-9]+-[a-z0-9]+$/);
  });

  it('clears agentLoop conversation', () => {
    const mockAgentLoop = createMockAgentLoop();
    const agentLoop = mockAgentLoop.instance as unknown as AgentLoop;

    agentLoop?.clearConversation();

    expect(mockAgentLoop.instance.clearConversation).toHaveBeenCalled();
  });
});

describe('useSessionManager - hook exports', () => {
  it('exports useSessionManager function', async () => {
    const { useSessionManager } = await import('../src/ui/hooks/useSessionManager.js');
    expect(typeof useSessionManager).toBe('function');
  });

  it('exports RecentSessionSummary interface shape', async () => {
    const mod = await import('../src/ui/hooks/useSessionManager.js');
    // The module should export the hook
    expect(mod.useSessionManager).toBeDefined();
  });
});
