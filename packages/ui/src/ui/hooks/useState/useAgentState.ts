import { useRef, useCallback } from 'react';

/**
 * Consolidates all agent execution tracking refs into a single hook.
 *
 * These refs are used across multiple event handlers and session lifecycle
 * methods in App.tsx. Extracting them into one hook reduces duplication
 * (the reset pattern was copy-pasted in 3 places) and keeps agent
 * execution state co-located.
 */

export interface AgentExecutionRefs {
  /** True while submitCommand is executing a command. */
  commandInFlightRef: React.MutableRefObject<boolean>;
  /** The run ID for the current agent turn (shared across thinking + tool events). */
  activeRunIdRef: React.MutableRefObject<string | null>;
  /** The message ID of the active thinking indicator (if any). */
  activeThinkingMessageIdRef: React.MutableRefObject<string | null>;
  /** The latest thinking content for the active run. */
  activeThinkingContentRef: React.MutableRefObject<string | null>;
  /** Map from toolName -> array of pending message IDs awaiting tool_end. */
  pendingToolMessageIdsRef: React.MutableRefObject<Map<string, string[]>>;
}

export interface AgentStateResult extends AgentExecutionRefs {
  /**
   * Reset all agent execution tracking refs to their initial state.
   * Called when clearing a session, resuming a session, or when the
   * agent loop emits a 'done' event.
   */
  resetAgentState: () => void;
}

export function useAgentState(): AgentStateResult {
  const commandInFlightRef = useRef<boolean>(false);
  const activeRunIdRef = useRef<string | null>(null);
  const activeThinkingMessageIdRef = useRef<string | null>(null);
  const activeThinkingContentRef = useRef<string | null>(null);
  const pendingToolMessageIdsRef = useRef<Map<string, string[]>>(new Map());

  const resetAgentState = useCallback(() => {
    activeRunIdRef.current = null;
    activeThinkingMessageIdRef.current = null;
    activeThinkingContentRef.current = null;
    pendingToolMessageIdsRef.current.clear();
  }, []);

  return {
    commandInFlightRef,
    activeRunIdRef,
    activeThinkingMessageIdRef,
    activeThinkingContentRef,
    pendingToolMessageIdsRef,
    resetAgentState,
  };
}

