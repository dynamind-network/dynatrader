import { useCallback, useEffect, useRef } from 'react';
import type { EffortLevel } from '../../core/providers/catalog.js';
import type { AgentLoop, Message as CoreMessage, ExecutionMode } from '../../index.js';
import type { Message } from '../types.js';
import { createWelcomeMessage as buildWelcomeMessage } from '../utils/chatHelpers.js';
import type {
  ClearSessionOptions,
  ResumeSessionOptions,
  SessionManagerResult,
} from './useSessionManager.js';
import type { AgentWizardState, QueuedPrompt, ScreenType } from './useState/useUIState.js';

/**
 * Options for the session lifecycle hook.
 */
interface SessionLifecycleOpts {
  sessionManagerHook: SessionManagerResult;
  agentLoop: AgentLoop | null;
  bootstrapAgent: (
    keys: Record<string, string>,
    messages: CoreMessage[],
    mode: ExecutionMode,
    sessionId?: string,
  ) => Promise<void>;
  resolvedApiKeys: Record<string, string>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setExecutionMode: (mode: ExecutionMode) => void;
  setCurrentModel: (model: string) => void;
  setEffort?: (effort: EffortLevel) => void;
  setSessionTitle: (title: string) => void;
  setActiveScreen: React.Dispatch<React.SetStateAction<ScreenType>>;
  setQueuedMessages: React.Dispatch<React.SetStateAction<QueuedPrompt[]>>;
  setPendingConnectProvider: React.Dispatch<React.SetStateAction<string | null>>;
  setAgentWizard: React.Dispatch<React.SetStateAction<AgentWizardState | null>>;
  toolState: { stopProcessing: () => void };
  sessionTitle: string;
  setIsSwitchingSession: React.Dispatch<React.SetStateAction<boolean>>;
  inputRef: React.RefObject<{ clear(): void }>;
  setSessionCreatedAt: (value: string) => void;
  sessionTitleRef: React.MutableRefObject<string>;
  titleGenerationInFlightRef: React.MutableRefObject<boolean>;
  titleGenerationDoneRef: React.MutableRefObject<boolean>;
  resetAgentState: () => void;
  /** Ref to populate with the clearToNewSession callback. */
  clearToNewSessionRef: React.MutableRefObject<() => Promise<void>>;
  /** Ref to populate with the resumeSession callback. */
  resumeSessionRef: React.MutableRefObject<
    (sessionId: string) => Promise<{ success: boolean; message: string }>
  >;
  /** Ref to populate with the loadRecentSessionsText callback. */
  loadRecentSessionsTextRef: React.MutableRefObject<() => Promise<string>>;
  /** Stable reference to loadRecentSessions (for use as useEffect dependency). */
  loadRecentSessions: () => Promise<void>;
  /** Stable reference to recentSessions array (for use as useEffect dependency). */
  recentSessions: Array<{ id: string; title: string; updatedAt: string }>;
  /** Suggestions for configured agents shown in the welcome message. */
  subagentSuggestions: Array<{ name: string; description?: string }>;
}

/**
 * Hook that manages session clear and resume operations.
 *
 * Populates the provided refs with stable callbacks, breaking
 * the forward-reference cycle in App.tsx.
 */
export function useSessionLifecycle(options: SessionLifecycleOpts): void {
  const {
    sessionManagerHook,
    agentLoop,
    bootstrapAgent,
    resolvedApiKeys,
    setMessages,
    setExecutionMode,
    setCurrentModel,
    setEffort,
    setSessionTitle,
    setActiveScreen,
    setQueuedMessages,
    setPendingConnectProvider,
    setAgentWizard,
    toolState,
    sessionTitle,
    setIsSwitchingSession,
    inputRef,
    setSessionCreatedAt,
    sessionTitleRef,
    titleGenerationInFlightRef,
    titleGenerationDoneRef,
    resetAgentState,
    clearToNewSessionRef,
    resumeSessionRef,
    loadRecentSessionsTextRef,
    loadRecentSessions,
    recentSessions,
    subagentSuggestions,
  } = options;

  // Use a ref for sessionManagerHook so the useEffects that populate refs
  // always see the latest value without depending on the unstable object.
  const sessionManagerHookRef = useRef(sessionManagerHook);
  sessionManagerHookRef.current = sessionManagerHook;
  const createWelcomeMessage = useCallback(
    () => buildWelcomeMessage(subagentSuggestions),
    [subagentSuggestions]
  );

  // Populate clearToNewSession ref
  useEffect(() => {
    clearToNewSessionRef.current = async () => {
      await sessionManagerHookRef.current.clearSession({
        agentLoop,
        setMessages,
        createWelcomeMessage,
        setSessionTitle,
        setActiveScreen,
        setSelectedSuggestionIndex: () => {},
        setQueuedMessages,
        setPendingConnectProvider,
        setAgentWizard,
        toolState,
        viewport: { jumpBottom: () => {} },
      });
      resetAgentState();
      inputRef.current?.clear();
      setSessionCreatedAt(new Date().toISOString());
      sessionTitleRef.current = 'New chat';
      titleGenerationInFlightRef.current = false;
      titleGenerationDoneRef.current = false;
    };
  }, [
    agentLoop,
    setMessages,
    setSessionTitle,
    setActiveScreen,
    setQueuedMessages,
    setPendingConnectProvider,
    setAgentWizard,
    toolState,
    inputRef,
    setSessionCreatedAt,
    resetAgentState,
    createWelcomeMessage,
  ]);

  // Populate resumeSession ref
  useEffect(() => {
    resumeSessionRef.current = async (sessionId: string) => {
      const resumeOptions: ResumeSessionOptions = {
        agentLoop,
        bootstrapAgent,
        resolvedApiKeys,
        setMessages,
        createWelcomeMessage,
        setExecutionMode,
        setCurrentModel,
        setEffort,
        setSessionTitle,
        setActiveScreen,
        setSelectedSuggestionIndex: () => {},
        setQueuedMessages,
        setPendingConnectProvider,
        setAgentWizard,
        toolState,
        viewport: { jumpBottom: () => {} },
      };
      const result = await sessionManagerHookRef.current.resumeSession(sessionId, resumeOptions);
      if (result.success) {
        setIsSwitchingSession(true);
        resetAgentState();
        inputRef.current?.clear();
        setSessionCreatedAt(new Date().toISOString());
        sessionTitleRef.current = sessionTitle;
        titleGenerationInFlightRef.current = false;
        titleGenerationDoneRef.current = true;
        setTimeout(() => setIsSwitchingSession(false), 0);
      }
      return result;
    };
  }, [
    agentLoop,
    bootstrapAgent,
    resolvedApiKeys,
    setMessages,
    setExecutionMode,
    setCurrentModel,
    setEffort,
    setSessionTitle,
    setActiveScreen,
    setQueuedMessages,
    setPendingConnectProvider,
    setAgentWizard,
    toolState,
    inputRef,
    setSessionCreatedAt,
    sessionTitle,
    resetAgentState,
    createWelcomeMessage,
  ]);

  // Populate loadRecentSessionsText ref
  // Uses stable `loadRecentSessions` and `recentSessions` as dependencies
  // instead of the entire `sessionManagerHook` object (which is a new
  // reference every render and causes infinite loops).
  useEffect(() => {
    loadRecentSessionsTextRef.current = async () => {
      await loadRecentSessions();
      if (recentSessions.length === 0) return 'No saved sessions found yet.';
      const idWidth = Math.max('Session ID'.length, ...recentSessions.map((s) => s.id.length));
      const titleWidth = Math.max('Title'.length, ...recentSessions.map((s) => s.title.length));
      const lines = [
        'Recent sessions:',
        `${'Session ID'.padEnd(idWidth)}  ${'Title'.padEnd(titleWidth)}  Updated`,
        `${'\u2500'.repeat(idWidth)}  ${'\u2500'.repeat(titleWidth)}  ${'\u2500'.repeat(19)}`,
        ...recentSessions.map((session) => {
          const updatedAt = session.updatedAt
            ? new Date(session.updatedAt).toLocaleString()
            : 'Unknown';
          return `${session.id.padEnd(idWidth)}  ${session.title.padEnd(titleWidth)}  ${updatedAt}`;
        }),
        '',
        'Use /resume <session-id> to continue one.',
      ];
      return lines.join('\n');
    };
  }, [loadRecentSessions, recentSessions]);
}

