import { useRef, useState } from 'react';
import type { QuestionOption } from '../../../core/types.js';
import type { CommandItem } from '../../common/CommandPalette.js';

/**
 * ScreenType represents all navigable screens in the terminal UI.
 */
export type ScreenType =
  | 'chat'
  | 'help'
  | 'markets'
  | 'chart'
  | 'portfolio'
  | 'trades'
  | 'alerts'
  | 'analysis'
  | 'news'
  | 'watchlist'
  | 'search'
  | 'autohedge'
  | 'settings'
  | 'models'
  | 'orderbook'
  | 'transcript'
  | 'sessions'
  | 'mcp';

/**
 * Defines the steps and collected data for the agent creation wizard.
 */
export interface AgentWizardState {
  step: 'name' | 'description' | 'scope' | 'tools' | 'maxTurns';
  data: {
    name?: string;
    description?: string;
    scope?: 'project' | 'global';
    tools?: string[];
    maxTurns?: number;
  };
}

export type QueuedPromptStatus = 'queued' | 'sending' | 'failed';

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  text: string;
  status: QueuedPromptStatus;
  error?: string;
}

let queuedPromptSequence = 0;

export function createQueuedPrompt(text: string, sessionId: string): QueuedPrompt {
  queuedPromptSequence += 1;
  return {
    id: `queued-${Date.now().toString(36)}-${queuedPromptSequence.toString(36)}`,
    sessionId,
    text,
    status: 'queued',
  };
}

export function updateQueueForSession(
  queues: Record<string, QueuedPrompt[]>,
  sessionId: string,
  action: React.SetStateAction<QueuedPrompt[]>,
): Record<string, QueuedPrompt[]> {
  const current = queues[sessionId] ?? [];
  const next = typeof action === 'function' ? action(current) : action;
  if (next.length > 0) return { ...queues, [sessionId]: next };
  if (!(sessionId in queues)) return queues;
  const remaining = { ...queues };
  delete remaining[sessionId];
  return remaining;
}

/**
 * Represents a pending question waiting for user input.
 */
export interface PendingQuestionState {
  question: string;
  options: QuestionOption[];
  defaultValue?: string;
  /** If true, user can type custom text as option 5 */
  allowCustomText?: boolean;
  resolve: (value: string | null) => void;
}

/**
 * Command palette item for the Ctrl+K command palette.
 * Re-exported from CommandPalette for convenience.
 */
export type { CommandItem } from '../../common/CommandPalette.js';

/**
 * All UI-related state consolidated into a single hook.
 *
 * These state variables were previously scattered throughout App.tsx.
 * Consolidating them into one hook:
 * 1. Reduces the number of useState/useRef declarations in the main component.
 * 2. Makes it easy to reset UI state when clearing or switching sessions.
 * 3. Keeps all presentation-layer state co-located.
 */
export interface UIStateResult {
  // --- Input state ---
  /** Whether input is currently blocked (e.g. during async operations). */
  inputBlockedRef: React.MutableRefObject<boolean>;
  /** Timeout handle for the input block (used to auto-unblock after a delay). */
  inputBlockTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // --- Navigation ---
  /** The currently active screen. */
  activeScreen: ScreenType;
  /** Navigate to a different screen. */
  setActiveScreen: React.Dispatch<React.SetStateAction<ScreenType>>;

  // --- Transcript ---
  /** Whether the transcript screen shows all messages (including system messages). */
  showAllInTranscript: boolean;
  /** Toggle the transcript view between full and recent. */
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether thinking blocks are visible in chat. */
  showThinking: boolean;
  /** Toggle thinking visibility in chat. */
  setShowThinking: React.Dispatch<React.SetStateAction<boolean>>;

  // --- Command palette ---
  /** The list of command palette items shown when Ctrl+K is pressed. */
  commandPaletteItems: CommandItem[];
  /** Update the command palette items list. */
  setCommandPaletteItems: React.Dispatch<React.SetStateAction<CommandItem[]>>;

  // --- Agent wizard ---
  /** Current state of the agent creation wizard, or null if not active. */
  agentWizard: AgentWizardState | null;
  /** Update the agent creation wizard state. */
  setAgentWizard: React.Dispatch<React.SetStateAction<AgentWizardState | null>>;

  // --- Provider connection ---
  /** Provider name awaiting API key input, or null if not connecting. */
  pendingConnectProvider: string | null;
  /** Set the provider being connected. */
  setPendingConnectProvider: React.Dispatch<React.SetStateAction<string | null>>;

  // --- Pending question ---
  /** A question waiting for user choice, or null if none is pending. */
  pendingQuestion: PendingQuestionState | null;
  /** Set or clear the pending question. */
  setPendingQuestion: React.Dispatch<React.SetStateAction<PendingQuestionState | null>>;
  /** Index of the currently selected question option (for arrow key navigation). */
  selectedQuestionIndex: number;
  /** Set the selected question option index. */
  setSelectedQuestionIndex: React.Dispatch<React.SetStateAction<number>>;

  // --- Message queue ---
  /** Queued prompts remain associated with their chat while switching sessions. */
  queuedMessagesBySession: Record<string, QueuedPrompt[]>;
  setQueuedMessagesBySession: React.Dispatch<React.SetStateAction<Record<string, QueuedPrompt[]>>>;

  // --- Session picker modal ---
  /** Whether the session picker modal is visible. */
  showSessionPicker: boolean;
  /** Show or hide the session picker modal. */
  setShowSessionPicker: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useUIState(): UIStateResult {
  // --- Input state ---
  const inputBlockedRef = useRef(false);
  const inputBlockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Navigation ---
  const [activeScreen, setActiveScreen] = useState<ScreenType>('chat');

  // --- Transcript ---
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [showThinking, setShowThinking] = useState(true);

  // --- Command palette ---
  const [commandPaletteItems, setCommandPaletteItems] = useState<CommandItem[]>([]);

  // --- Agent wizard ---
  const [agentWizard, setAgentWizard] = useState<AgentWizardState | null>(null);

  // --- Provider connection ---
  const [pendingConnectProvider, setPendingConnectProvider] = useState<string | null>(null);

  // --- Pending question ---
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionState | null>(null);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);

  // --- Message queue ---
  const [queuedMessagesBySession, setQueuedMessagesBySession] = useState<Record<string, QueuedPrompt[]>>({});

  // --- Session picker modal ---
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  return {
    inputBlockedRef,
    inputBlockTimeoutRef,
    activeScreen,
    setActiveScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    showThinking,
    setShowThinking,
    commandPaletteItems,
    setCommandPaletteItems,
    agentWizard,
    setAgentWizard,
    pendingConnectProvider,
    setPendingConnectProvider,
    pendingQuestion,
    setPendingQuestion,
    selectedQuestionIndex,
    setSelectedQuestionIndex,
    queuedMessagesBySession,
    setQueuedMessagesBySession,
    showSessionPicker,
    setShowSessionPicker,
  };
}

