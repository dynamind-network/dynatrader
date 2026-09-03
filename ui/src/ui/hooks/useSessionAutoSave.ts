import { useEffect, useRef, useCallback } from 'react';
import type { AgentLoop, ExecutionMode, SessionManager } from '../../index.js';
import type { EffortLevel } from '../../core/providers/catalog.js';
import type { Message } from '../types.js';
import { deriveCoreConversation, serializeChatMessages } from '../utils/chatHelpers.js';

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
    runId?: string;
    preview?: string;
    toolArtifact?: unknown;
  }>;
}

/**
 * Derives a lightweight fingerprint from the messages array so we only
 * trigger a save when something semantically meaningful changes (message
 * count or the last message's id/timestamp/status).  This avoids firing on
 * every reference-equality change caused by intermediate status updates.
 */
function deriveMessageFingerprint(messages: Message[]): string {
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.id ?? ''}:${last.timestamp?.getTime() ?? 0}:${last.status ?? ''}`;
}

/**
 * Auto-saves the current session with:
 * - 10-minute periodic save (resets on activity)
 * - Immediate triggers: model change, mode change, tool completion, explicit save
 *
 * The save is triggered when a *meaningful* change is detected:
 *   - message count change or last message identity change
 *   - session title change
 *   - model / execution-mode change
 *   - active session id change
 *
 * loadRecentSessions is NOT called on every save -- it is expensive because
 * it reads every session file from disk.  Instead we refresh the list at most
 * once every 10 seconds (or on explicit user actions like /resume).
 */
export function useSessionAutoSave(options: {
  sessionManager: SessionManager;
  loadRecentSessions: () => Promise<void>;
  agentLoop: AgentLoop | null;
  activeSessionId: string;
  messages: Message[];
  sessionTitle: string;
  sessionCreatedAt: string;
  currentModel: string;
  executionMode: ExecutionMode;
  effort: EffortLevel;
  isSwitchingSession: boolean;
  cwd: string;
}): {
  /** Force an immediate save (used before exit, on model change, etc.) */
  forceSave: () => Promise<void>;
} {
  const {
    sessionManager,
    loadRecentSessions,
    agentLoop,
    activeSessionId,
    messages,
    sessionTitle,
    sessionCreatedAt,
    currentModel,
    executionMode,
    effort,
    isSwitchingSession,
    cwd,
  } = options;

  // We use refs so the debounced timer always sees the latest values without
  // needing to restart the timer when non-semantic values shift.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionTitleRef = useRef(sessionTitle);
  sessionTitleRef.current = sessionTitle;
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const executionModeRef = useRef(executionMode);
  executionModeRef.current = executionMode;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const sessionCreatedAtRef = useRef(sessionCreatedAt);
  sessionCreatedAtRef.current = sessionCreatedAt;
  const agentLoopRef = useRef(agentLoop);
  agentLoopRef.current = agentLoop;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const isSwitchingSessionRef = useRef(isSwitchingSession);
  isSwitchingSessionRef.current = isSwitchingSession;
  const sessionManagerRef = useRef(sessionManager);
  sessionManagerRef.current = sessionManager;

  // -- Debounced save (2 s) for quick changes --
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Periodic save every 10 minutes (resets on activity) --
  const periodicSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetPeriodicTimer = useCallback(() => {
    if (periodicSaveTimerRef.current !== null) {
      clearTimeout(periodicSaveTimerRef.current);
    }
    periodicSaveTimerRef.current = setTimeout(
      () => {
        periodicSaveTimerRef.current = null;
        performSave();
      },
      10 * 60 * 1000
    ); // 10 minutes
  }, []);

  const performSave = useCallback(async () => {
    if (isSwitchingSessionRef.current) return;
    const msgs = messagesRef.current;
    const conversation = agentLoopRef.current?.getConversation() ?? deriveCoreConversation(msgs);
    const metadata: StoredSessionMetadata = {
      title: sessionTitleRef.current,
      createdAt: sessionCreatedAtRef.current,
      updatedAt: new Date().toISOString(),
      model: currentModelRef.current,
      executionMode: executionModeRef.current,
      effort: effortRef.current,
      cwd: cwdRef.current,
      chatMessages: serializeChatMessages(msgs),
    };
    await sessionManagerRef.current.saveSession(activeSessionIdRef.current, {
      messages: conversation,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }, []);

  // Force save - exported for use before exit, model changes, etc.
  const forceSave = useCallback(async () => {
    await performSave();
  }, [performSave]);

  // Reset periodic timer on any meaningful activity
  const activityRef = useRef<{
    messages: number;
    sessionTitle: string;
    currentModel: string;
    executionMode: ExecutionMode;
    effort: EffortLevel;
  }>({
    messages: messages.length,
    sessionTitle: sessionTitle,
    currentModel: currentModel,
    executionMode: executionMode,
    effort: effort,
  });

  // Detect activity and reset periodic timer
  useEffect(() => {
    const hasActivity =
      activityRef.current.messages !== messages.length ||
      activityRef.current.sessionTitle !== sessionTitle ||
      activityRef.current.currentModel !== currentModel ||
      activityRef.current.executionMode !== executionMode ||
      activityRef.current.effort !== effort;

    if (hasActivity) {
      activityRef.current = {
        messages: messages.length,
        sessionTitle: sessionTitle,
        currentModel: currentModel,
        executionMode: executionMode,
        effort: effort,
      };
      resetPeriodicTimer();
    }
  }, [messages.length, sessionTitle, currentModel, executionMode, effort, resetPeriodicTimer]);

  // Initialize periodic timer on mount
  useEffect(() => {
    resetPeriodicTimer();
    return () => {
      if (periodicSaveTimerRef.current !== null) {
        clearTimeout(periodicSaveTimerRef.current);
      }
    };
  }, [resetPeriodicTimer]);

  // Schedule a debounced save when the semantic fingerprint changes.
  useEffect(() => {
    if (isSwitchingSession) return;

    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      performSave();
    }, 2000);

    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    activeSessionId,
    deriveMessageFingerprint(messages),
    sessionTitle,
    currentModel,
    executionMode,
    effort,
    isSwitchingSession,
    performSave,
  ]);

  // -- Periodic recent-sessions refresh (10 s) --
  // This replaces the per-save loadRecentSessions call that caused EMFILE.
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void loadRecentSessions();

    refreshTimerRef.current = setInterval(() => {
      void loadRecentSessions();
    }, 10_000);

    return () => {
      if (refreshTimerRef.current !== null) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [loadRecentSessions]);

  return { forceSave };
}
