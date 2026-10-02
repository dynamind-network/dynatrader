import { useCallback, useEffect, useState } from 'react';
import type { EffortLevel } from '../../core/providers/catalog.js';
import {
  AgentLoop,
  type Message as CoreMessage,
  type ExecutionMode,
  SessionManager,
} from '../../index.js';
import type { QueuedPrompt } from './useState/useUIState.js';

interface StoredSessionMetadata {
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  executionMode?: ExecutionMode;
  effort?: EffortLevel;
  cwd: string;
  chatMessages?: Array<{
    id?: string;
    role: string;
    content: string;
    timestamp: string;
    status?: string;
    toolName?: string;
    inputPreview?: string;
    resultPreview?: string;
    runId?: string;
    preview?: string;
    toolArtifact?: unknown;
  }>;
}

export interface RecentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ResumeSessionOptions {
  agentLoop: AgentLoop | null;
  bootstrapAgent: (
    keys: Record<string, string>,
    messages: CoreMessage[],
    mode: ExecutionMode,
    sessionId?: string,
  ) => Promise<void>;
  resolvedApiKeys: Record<string, string>;

  setMessages: any;
  createWelcomeMessage: () => unknown;
  setExecutionMode: (mode: ExecutionMode) => void;
  setCurrentModel: (model: string) => void;
  setEffort?: (effort: EffortLevel) => void;

  setSessionTitle: any;

  setActiveScreen: any;
  setSelectedSuggestionIndex: (index: number) => void;

  setQueuedMessages: React.Dispatch<React.SetStateAction<QueuedPrompt[]>>;

  setPendingConnectProvider: any;

  setAgentWizard: any;
  toolState: { stopProcessing: () => void };
  viewport: { jumpBottom: () => void };
}

export interface ClearSessionOptions {
  agentLoop: AgentLoop | null;

  setMessages: any;
  createWelcomeMessage: () => unknown;

  setSessionTitle: any;

  setActiveScreen: any;
  setSelectedSuggestionIndex: (index: number) => void;

  setQueuedMessages: React.Dispatch<React.SetStateAction<QueuedPrompt[]>>;

  setPendingConnectProvider: any;

  setAgentWizard: any;
  toolState: { stopProcessing: () => void };
  viewport: { jumpBottom: () => void };
}

export interface SessionManagerResult {
  activeSessionId: string;
  sessionTitle: string;
  recentSessions: RecentSessionSummary[];
  resumeSession: (
    sessionId: string,
    options: ResumeSessionOptions
  ) => Promise<{ success: boolean; message: string }>;
  clearSession: (options: ClearSessionOptions) => Promise<void>;
  loadRecentSessions: () => Promise<void>;
  /** Format recent sessions as display text (for /resume command). */
  loadRecentSessionsText: () => Promise<string>;
  setActiveSessionId: (id: string) => void;
  setSessionTitle: (title: string) => void;
}

const createSessionId = (): string =>
  `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function getAgentTranscript(
  coreMessages: CoreMessage[],
  chatMessages?: NonNullable<StoredSessionMetadata['chatMessages']>,
): CoreMessage[] {
  if (coreMessages.length > 0) return coreMessages;
  return (chatMessages ?? [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map(({ role, content }) => ({ role: role as 'user' | 'assistant', content }));
}

export function useSessionManager(
  sessionManager: SessionManager,
  _agentLoop: AgentLoop | null,
  _cwd: string
): SessionManagerResult {
  const [activeSessionId, setActiveSessionId] = useState(() => createSessionId());
  const [sessionTitle, setSessionTitle] = useState('New chat');
  const [recentSessions, setRecentSessions] = useState<RecentSessionSummary[]>([]);

  const loadRecentSessionSummaries = useCallback(async (): Promise<RecentSessionSummary[]> => {
    const sessionIds = await sessionManager.listSessions();

    const sessions = (
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          const session = await sessionManager.loadSession(sessionId);
          const metadata = (session?.metadata ?? {}) as unknown as StoredSessionMetadata;

          return session
            ? {
                id: sessionId,
                title: metadata.title || 'Untitled chat',
                updatedAt: metadata.updatedAt || metadata.createdAt || '',
              }
            : null;
        })
      )
    )
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);

    return sessions;
  }, [sessionManager]);

  const loadRecentSessionsText = useCallback(async (): Promise<string> => {
    const sessions = await loadRecentSessionSummaries();

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
  }, [loadRecentSessionSummaries]);

  const refreshRecentSessions = useCallback(async () => {
    const sessions = await loadRecentSessionSummaries();
    setRecentSessions(sessions);
  }, [loadRecentSessionSummaries]);

  useEffect(() => {
    void refreshRecentSessions();
  }, [refreshRecentSessions]);

  const resumeSession = useCallback(
    async (
      sessionId: string,
      options: ResumeSessionOptions
    ): Promise<{ success: boolean; message: string }> => {
      const session = await sessionManager.loadSession(sessionId);
      if (!session) {
        const recentSessionsText = await loadRecentSessionsText();
        return {
          success: false,
          message: `Unknown session: ${sessionId}\n\n${recentSessionsText}`,
        };
      }

      const metadata = (session.metadata ?? {}) as unknown as StoredSessionMetadata;
      const agentTranscript = getAgentTranscript(session.messages, metadata.chatMessages);
      const restoredChatMessages =
        metadata.chatMessages && metadata.chatMessages.length > 0
          ? metadata.chatMessages.map((msg) => ({
              id: msg.id,
              role: msg.role,
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              status: msg.status,
              toolName: msg.toolName,
              inputPreview: msg.inputPreview,
              resultPreview: msg.resultPreview,
              runId: msg.runId,
              preview: msg.preview,
              toolArtifact: msg.toolArtifact,
            }))
          : session.messages.map((message) => ({
              role: message.role,
              content:
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content),
              timestamp: new Date(),
            }));

      options.setMessages(
        restoredChatMessages.length > 0 ? restoredChatMessages : [options.createWelcomeMessage()]
      );
      options.viewport.jumpBottom();
      options.setPendingConnectProvider(null);
      options.setAgentWizard(null);
      options.setSelectedSuggestionIndex(0);
      options.setActiveScreen('chat');
      setActiveSessionId(sessionId);
      const restoredTitle = metadata.title?.trim() || 'New chat';
      options.setSessionTitle(restoredTitle);
      const restoredMode: ExecutionMode =
        metadata.executionMode === 'auto-approve' ? 'auto-approve' : 'normal';
      options.setExecutionMode(restoredMode);
      if (metadata.model) {
        options.setCurrentModel(metadata.model);
      }
      if (metadata.effort && options.setEffort) {
        options.setEffort(metadata.effort);
      }
      options.toolState.stopProcessing();

      if (options.agentLoop) {
        // Restoring UI state alone leaves the live RPC adapter on its previous
        // approval mode, so the footer can say AUTO while tools still prompt.
        await options.agentLoop.endSession();
        options.agentLoop.setExecutionMode(restoredMode);
        await options.agentLoop.restoreSession(sessionId, agentTranscript);
      } else {
        await options.bootstrapAgent(options.resolvedApiKeys, agentTranscript, restoredMode, sessionId);
      }

      return { success: true, message: '' };
    },
    [sessionManager, loadRecentSessionsText]
  );

  const clearSession = useCallback(async (options: ClearSessionOptions): Promise<void> => {
    await options.agentLoop?.endSession();
    options.agentLoop?.clearConversation();
    options.setMessages([options.createWelcomeMessage()]);
    options.viewport.jumpBottom();
    options.setQueuedMessages([]);
    options.setPendingConnectProvider(null);
    options.setAgentWizard(null);
    options.setSelectedSuggestionIndex(0);
    options.setActiveScreen('chat');
    setActiveSessionId(createSessionId());
    options.setSessionTitle('New chat');
    options.toolState.stopProcessing();
  }, []);

  return {
    activeSessionId,
    sessionTitle,
    recentSessions,
    resumeSession,
    clearSession,
    loadRecentSessions: refreshRecentSessions,
    loadRecentSessionsText,
    setActiveSessionId,
    setSessionTitle,
  };
}

