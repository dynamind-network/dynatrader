import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { setSessionInfoForExit } from '../cli.js';
import { selectInitialSessionId } from '../cli-session-options.js';
import { loadConfig, saveLastModel } from '../config/config.js';
import { WalletProvider } from '../contexts/WalletContext.js';
import { AgentLoop } from '../core/agent-loop.js';
import { SessionManager } from '../core/context-manager.js';
import { type CatalogModel, EFFORT_LEVELS, type EffortLevel, findProviderForModel, listCatalogModels } from '../core/providers/catalog.js';
import { PROVIDERS, refreshModels } from '../core/providers/registry.js';
import { createSystemPrompt } from '../core/system-prompt.js';
import type { AgentEvent, ExecutionMode, QuestionPrompt } from '../core/types.js';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { createAgentLoopEventHandler } from '../services/ToolStateManager.js';
import { ToolStateProvider, useToolState } from '../services/ToolStateManagerProvider.js';
import { getDynamindPath } from '../utils/constants.js';
import { ChatStatusBanner } from './common/ChatStatusBanner.js';
import { ChatViewport } from './common/ChatViewport.js';
import { CommandInput, type CommandInputHandle } from './common/CommandInput.js';
import { useCommandPalette } from './common/CommandPalette.js';
import { ErrorBoundary } from './common/ErrorBoundary.js';
import { HeaderNav } from './common/HeaderNav.js';
import { NotificationToast } from './common/NotificationToast.js';
import { SessionPickerModal } from './common/SessionPickerModal.js';
import { StatusLine } from './common/StatusLine.js';
import ThinkingAnimation from './common/ThinkingAnimation.js';
import { TimelineSidebar } from './common/TimelineSidebar.js';
import {
  ModelStateProvider,
  SessionStateProvider,
  useModelState,
  useSessionState,
} from './contexts/AppStateContext.js';
import { SPACING } from './design/tokens.js';
import { useAgentBootstrap } from './hooks/useAgentBootstrap.js';
import { useApiKeys } from './hooks/useApiKeys.js';
import { useAppCommandPalette } from './hooks/useAppCommandPalette.js';
import { useChatMessageHelpers } from './hooks/useChatMessageHelpers.js';
import { useChatViewport } from './hooks/useChatViewport.js';
import { useCommandService } from './hooks/useCommandService.js';
import { useInputHandler } from './hooks/useInputHandler.js';
import { useLayoutMeasurement } from './hooks/useLayoutMeasurement.js';
import { useMessageQueueDrain } from './hooks/useMessageQueueDrain.js';
import { useSessionAutoSave } from './hooks/useSessionAutoSave.js';
import { useSessionLifecycle } from './hooks/useSessionLifecycle.js';
import { useSessionManager } from './hooks/useSessionManager.js';
import { useAgentState } from './hooks/useState/useAgentState.js';
import { createQueuedPrompt, type QueuedPrompt, type ScreenType, updateQueueForSession, useUIState } from './hooks/useState/useUIState.js';
import { useStatusPolling } from './hooks/useStatusPolling.js';
import { useTimelineEventHandler } from './hooks/useTimelineEventHandler.js';
import { useTitleGeneration } from './hooks/useTitleGeneration.js';
import { MouseRegion, useMouseBus } from './input/MouseInputProvider.js';
import { SplitPaneLayout } from './layout/SplitPaneLayout.js';
import { ScreenRouter, StandaloneScreenRenderer } from './renderers/ScreenRouter.js';
import { MCPScreen } from './screens/MCPScreen.js';
import { ModelsScreen } from './screens/ModelsScreen.js';
import { TranscriptScreen } from './screens/TranscriptScreen.js';
import { getInputPlaceholder } from './utils/chatHelpers.js';

const createTitleProvider = async (providerName: string, apiKey: string) => {
  const { createProvider } = await import('../core/providers/index.js');
  return createProvider(providerName, apiKey);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppProps {
  apiKeys: Record<string, string>;
  config: {
    model: string | null;
    systemPromptFile?: string;
    maxTurns: number;
    allowedTools?: string[];
    disallowedTools?: string[];
    cwd: string;
    verbose: boolean;
  };
  initialPrompt?: string;
  sessionId?: string;
  continueSession?: boolean;
}

// ---------------------------------------------------------------------------
// AppContent (shell component)
// ---------------------------------------------------------------------------

function AppContent({ apiKeys, config, initialPrompt, sessionId, continueSession }: AppProps) {
  const [selectedMarketSymbol, setSelectedMarketSymbol] = useState<string | undefined>();
  // -- Centralized tool state management --
  const toolState = useToolState();

  // -- Terminal size --
  const terminalSize = useTerminalSize();

  // -- Consolidated UI state --
  const {
    inputBlockedRef,
    activeScreen,
    setActiveScreen,
    showAllInTranscript,
    commandPaletteItems,
    setCommandPaletteItems,
    agentWizard,
    setAgentWizard,
    pendingConnectProvider,
    setPendingConnectProvider,
    pendingQuestion,
    setPendingQuestion,
    queuedMessagesBySession,
    setQueuedMessagesBySession,
    showSessionPicker,
    setShowSessionPicker,
  } = useUIState();

  // -- Input ref for isolated input state --
  const inputRef = useRef<CommandInputHandle>(null);

  // -- Agent execution refs --
  const {
    commandInFlightRef,
    activeRunIdRef,
    activeThinkingMessageIdRef,
    activeThinkingContentRef,
    pendingToolMessageIdsRef,
    resetAgentState,
  } = useAgentState();

  // -- Title generation refs (declared early for use in session wrappers) --
  const titleGenerationInFlightRef = useRef<boolean>(false);
  const titleGenerationDoneRef = useRef<boolean>(false);
  const sessionTitleRef = useRef<string>('New chat');

  // -- Model state (extracted to ModelStateContext) --
  const {
    currentModel,
    setCurrentModel,
    catalogModels,
    setCatalogModels,
    selectedModelIndex,
    setSelectedModelIndex,
    effort,
    setEffort,
    effortIndex,
    setEffortIndex,
    modelPickerPhase,
    setModelPickerPhase,
    pendingEffortModelId,
    setPendingEffortModelId,
    executionMode,
    setExecutionMode,
  } = useModelState();

  // Session state (extracted to SessionStateContext)
  const {
    messages,
    setMessages,
    sessionCreatedAt,
    setSessionCreatedAt,
    isSwitchingSession,
    setIsSwitchingSession,
  } = useSessionState();

  // -- Split pane state --
  const [splitMode, setSplitMode] = useState(false);
  const [rightScreen, setRightScreen] = useState<ScreenType>('markets');

  // New feature state
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [autoLintErrors, setAutoLintErrors] = useState(0);
  const [showTimeline, setShowTimeline] = useState(false);

  // -- Double Ctrl+C state --
  const [quitShortcutArmed, setQuitShortcutArmed] = useState(false);
  const quitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messagesRef = useRef(messages);
  const pendingQuestionRef = useRef(pendingQuestion);
  const askQuestionRef = useRef<(prompt: QuestionPrompt) => Promise<string | null>>(
    async () => null
  );

  // -- API key management --
  const { resolvedApiKeys, isLoading: isLoadingApiKeys, refreshApiKeys } = useApiKeys(apiKeys);
  const hasAnyApiKey = React.useMemo(
    () =>
      Object.values(resolvedApiKeys).some(
        (value) => typeof value === 'string' && value.trim().length > 0
      ),
    [resolvedApiKeys]
  );

  // -- Load last used model from config on startup --
  useEffect(() => {
    const loadLastModel = async () => {
      try {
        const cfg = await loadConfig(config.cwd);
        if (cfg.lastModel && currentModel === null) {
          setCurrentModel(cfg.lastModel);
        }
      } catch (error) {
        // Config load failed, will use default
      }
    };
    loadLastModel();
  }, []); // Run once on mount

  // -- Model change handler that persists to config --
  const handleSetCurrentModel = useCallback((model: string) => {
    setCurrentModel(model);
    void saveLastModel(model);
  }, []);

  // -- Handle initial prompt from CLI --
  useEffect(() => {
    if (initialPrompt && inputRef.current?.getValue() === '') {
      inputRef.current?.setValue(initialPrompt);
    }
  }, [initialPrompt]);

  // -- Double Ctrl+C handler (Codex CLI style) --
  useInput(
    (input, key) => {
      if (!key.ctrl || input !== 'c') return;

      if (quitShortcutArmed) {
        handleQuitShortcut();
      } else {
        armQuitShortcut();
      }
    },
    { isActive: !toolState.state.isProcessing }
  );

  // -- Split pane toggle (Ctrl+\) --
  const activeScreenRef = useRef(activeScreen);
  activeScreenRef.current = activeScreen;

  useInput(
    (inputChar, key) => {
      if (key.ctrl && inputChar === '\\') {
        setSplitMode((prev) => {
          const next = !prev;
          if (next && activeScreenRef.current !== 'chat') {
            setRightScreen(activeScreenRef.current);
            setActiveScreen('chat');
          }
          return next;
        });
      }
    },
    { isActive: true }
  );

  // -- Session management --
  const sessionManager = React.useMemo(
    () => new SessionManager(getDynamindPath('sessions')),
    [config.cwd]
  );
  const sessionManagerHook = useSessionManager(sessionManager, null, config.cwd);
  const { activeSessionId, sessionTitle, recentSessions, setSessionTitle } = sessionManagerHook;
  const queuedMessages = queuedMessagesBySession[activeSessionId] ?? [];
  const setQueuedMessages = useCallback<React.Dispatch<React.SetStateAction<QueuedPrompt[]>>>(
    (action) => {
      setQueuedMessagesBySession((previous) => updateQueueForSession(previous, activeSessionId, action));
    },
    [activeSessionId, setQueuedMessagesBySession],
  );
  const initialSessionResumeStartedRef = useRef(false);

  // -- Refs for exit handling (must be after sessionManagerHook) --
  const sessionTitleForExitRef = useRef(sessionTitle);
  const activeSessionIdForExitRef = useRef(activeSessionId);
  sessionTitleForExitRef.current = sessionTitle;
  activeSessionIdForExitRef.current = activeSessionId;

  // -- Session lifecycle refs (populated by useSessionLifecycle hook) --
  const clearToNewSessionRef = useRef<() => Promise<void>>(async () => {});
  const resumeSessionRef = useRef<
    (sessionId: string) => Promise<{ success: boolean; message: string }>
  >(async () => ({ success: false, message: '' }));
  const loadRecentSessionsTextRef = useRef<() => Promise<string>>(async () => '');

  const clearToNewSession = useCallback(async () => clearToNewSessionRef.current(), []);
  const resumeSession = useCallback(
    async (sessionId: string) => resumeSessionRef.current(sessionId),
    []
  );
  const loadRecentSessionsText = useCallback(async () => loadRecentSessionsTextRef.current(), []);

  // -- Double Ctrl+C handling (Codex CLI style) --
  const QUIT_SHORTCUT_TIMEOUT_MS = 2000;
  const forceSaveRef = useRef<() => Promise<void>>(async () => {});

  const armQuitShortcut = useCallback(() => {
    if (quitTimeoutRef.current) {
      clearTimeout(quitTimeoutRef.current);
    }
    setQuitShortcutArmed(true);
    quitTimeoutRef.current = setTimeout(() => {
      setQuitShortcutArmed(false);
      quitTimeoutRef.current = null;
    }, QUIT_SHORTCUT_TIMEOUT_MS);
  }, []);

  const handleQuitShortcut = useCallback(async () => {
    if (quitTimeoutRef.current) {
      clearTimeout(quitTimeoutRef.current);
      quitTimeoutRef.current = null;
    }
    setQuitShortcutArmed(false);
    await forceSaveRef.current();

    // Output session info directly since process.exit skips cli.ts handlers
    console.log('');
    console.log('============================================================');
    console.log('  Session saved');
    console.log('============================================================');
    console.log(
      `  Session: ${activeSessionIdForExitRef.current} - "${sessionTitleForExitRef.current}"`
    );
    console.log(`  Continue: dynamind -s ${activeSessionIdForExitRef.current}`);
    console.log('============================================================');

    process.exit(0);
  }, []);

  // Timeline event handler ref (needed before hook call for useAgentBootstrap)
  const handleTimelineEventRef = useRef<(event: AgentEvent) => void>(() => {});

  // -- Agent bootstrap --
  const handlers = createAgentLoopEventHandler(toolState);
  const {
    agentLoop,
    subagentRegistry,
    subagentSuggestions,
    bootstrap: bootstrapAgent,
    isBootstrapping,
  } = useAgentBootstrap(
    {
      cwd: config.cwd,
      maxTurns: config.maxTurns,
      systemPrompt: createSystemPrompt(config.cwd),
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
    },
    currentModel ?? '',
    executionMode,
    (event) => {
      handlers.handleEvent(event);
      if (event.type === 'subagent_activity') {
        setMessages((previous) => [...previous, {
          id: `agent:${event.taskId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          role: 'tool',
          content: '',
          toolName: `↳ ${event.agentName} · ${event.taskId.slice(0, 8)}`,
          preview: event.activity,
          status: event.status === 'failed' ? 'error' : event.status === 'completed' ? 'completed' : 'pending',
          timestamp: new Date(),
          commandOutput: true,
        }]);
      }
      if (event.type === 'turn_end') {
        const seconds = (event.durationMs / 1000).toFixed(1);
        const hooksPassed = event.hooksPassed ?? 0;
        const hooksFailed = event.hooksFailed ?? 0;
        const hookLabel = hooksPassed + hooksFailed > 0
          ? `hooks: ${hooksPassed} passed${hooksFailed ? `, ${hooksFailed} failed` : ''}`
          : 'hooks: none';
        setMessages((previous) => [...previous, {
          id: `turn-end:${Date.now()}`,
          role: 'system',
          content: `◆ stop  [${hookLabel}]\nTurn completed in ${seconds}s.`,
          timestamp: new Date(),
          commandOutput: true,
        }]);
      }
    },
    handlers.handleApprovalRequired,
    (event) => handleTimelineEventRef.current(event),
    resolvedApiKeys
  );

  const applyExecutionMode = useCallback(
    (mode: ExecutionMode) => {
      setExecutionMode(mode);
      agentLoop?.setExecutionMode(mode);
    },
    [agentLoop]
  );

  // Sync effort to agent loop whenever it changes
  useEffect(() => {
    agentLoop?.setEffort(effort);
  }, [effort, agentLoop]);

  const workspaceAgentCount = subagentRegistry?.getVisible().length ?? 0;

  // -- Sync refs --
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    pendingQuestionRef.current = pendingQuestion;
  }, [pendingQuestion]);

  // -- Status polling --
  const { gitStatus, contextUsage } = useStatusPolling(config.cwd, agentLoop, currentModel ?? '');

  // -- Layout measurement --
  // Only layout-affecting props are passed; transient state (isProcessing,
  // currentModel, pendingApprovalCount) is excluded to prevent flickering.
  const { chromeRef, footerRef, chromeHeight, footerHeight } = useLayoutMeasurement({
    activeScreen,
    terminalHeight: terminalSize.height,
    terminalWidth: terminalSize.width,
    hasPendingQuestion: Boolean(pendingQuestion),
    hasPendingApproval: toolState.state.pendingApprovals.length > 0,
  });

  // -- Chat viewport --
  const mainAreaHeight = Math.max(1, terminalSize.height - chromeHeight - footerHeight);
  const chatHistory = React.useMemo(
    () => messages.filter((message) => message.role !== 'system' || message.commandOutput === true),
    [messages]
  );
  const viewport = useChatViewport(chatHistory, terminalSize.width, mainAreaHeight);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState(0);

  // -- Command palette --
  const { isOpen: isCommandPaletteOpen, CommandPalette: CommandPaletteView } =
    useCommandPalette(commandPaletteItems);

  // -- Chat message helpers --
  const { appendChatMessage, updateChatMessage } = useChatMessageHelpers(setMessages);

  // -- Auto-bootstrap side-effect --
  useEffect(() => {
    if (resolvedApiKeys && Object.keys(resolvedApiKeys).length) {
      bootstrapAgent(resolvedApiKeys);
    }
  }, [resolvedApiKeys, bootstrapAgent]);

  // -- Set up auto-checkpoint callback on agent --
  useEffect(() => {
    if (agentLoop && activeSessionId) {
      agentLoop.setAutoCheckpoint(async (label: string) => {
        const [{ getCheckpointManager }, { getUndoRedoManager }] = await Promise.all([
          import('../core/git-checkpoint.js'),
          import('../core/undo-redo.js'),
        ]);
        const manager = getCheckpointManager(config.cwd, activeSessionId);
        const checkpoint = manager.createCheckpoint(label);
        if (checkpoint) {
          const undoRedo = getUndoRedoManager();
          undoRedo.push(checkpoint);
          setUndoCount(undoRedo.getUndoCount());
          setRedoCount(undoRedo.getRedoCount());
        }
      });
    }
  }, [agentLoop, activeSessionId, config.cwd]);

  // -- Auto-lint after file modifications --
  useEffect(() => {
    if (toolState.state.isProcessing) return;
    const timeout = setTimeout(() => {
      void import('../core/auto-lint.js').then(({ runAutoLint, formatLintResults }) => {
        const results = runAutoLint(config.cwd);
        setAutoLintErrors(results.filter((r) => r.severity === 'error').length);
        if (results.length > 0) {
          const formatted = formatLintResults(results);
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: formatted,
              timestamp: new Date(),
              commandOutput: true,
            },
          ]);
        }
      });
    }, 1000);
    return () => clearTimeout(timeout);
  }, [toolState.state.isProcessing, config.cwd]);

  // -- Timeline event handler (uses refs to break forward-reference cycle) --
  useTimelineEventHandler({
    appendChatMessage,
    updateChatMessage,
    activeRunIdRef,
    activeThinkingMessageIdRef,
    activeThinkingContentRef,
    pendingToolMessageIdsRef,
    handleTimelineEventRef,
  });

  // -- Command service --
  const commandServiceResult = useCommandService({
    agentLoop: agentLoop!,
    subagentRegistry,
    cwd: config.cwd,
    activeSessionId,
    appendChatMessage,
    toolState,
    setActiveScreen,
    setPendingConnectProvider,
    setAgentWizard,
    setMessages,
    clearToNewSession,
    loadRecentSessionsText,
    resumeSession,
    askQuestionRef,
    pendingQuestionRef,
    commandInFlightRef,
    messagesRef,
    refreshApiKeys,
    bootstrapAgent,
    resolvedApiKeys,
    setCurrentModel: handleSetCurrentModel,
    onShowSessionPicker: () => setShowSessionPicker(true),
    currentModel,
    currentEffort: effort,
    onEffortChange: (level: string) => setEffort(level as EffortLevel),
  });
  const { commandService, submitCommand } = commandServiceResult;

  // -- Input handler --
  const inputHandler = useInputHandler({
    toolState,
    pendingQuestionRef,
    agentWizard,
    pendingConnectProvider,
    onSetPendingQuestion: setPendingQuestion,
    onSetAgentWizard: setAgentWizard,
    onSetPendingConnectProvider: setPendingConnectProvider,
    onSubmitMessage: () => {},
    inputRef,
    onSetMessages: setMessages,
    resolvedApiKeys,
    isLoadingApiKeys,
    isBootstrapping,
    currentModel,
    activeSessionId,
    submitCommand,
    commandInFlightRef,
    onSetQueuedMessages: setQueuedMessages,
    configCwd: config.cwd,
    commandService,
    createCustomAgent: async (data: Record<string, unknown>) => {
      return (commandService as any).createCustomAgent(data);
    },
    onAlwaysApprove: () => {
      setExecutionMode('auto-approve');
      agentLoop?.setExecutionMode('auto-approve');
    },
  });
  const { handleSubmit, resolvePendingApproval, resolvePendingQuestion, askQuestion } =
    inputHandler;

  useEffect(() => {
    askQuestionRef.current = askQuestion;
  }, [askQuestion]);

  // -- Session lifecycle (populates refs for clear/resume/list) --
  useSessionLifecycle({
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
    loadRecentSessions: sessionManagerHook.loadRecentSessions,
    recentSessions: sessionManagerHook.recentSessions,
    subagentSuggestions,
  });

  // Register after useSessionLifecycle so its effect has populated the ref
  // before the CLI -s resume effect tries to use it.
  useEffect(() => {
    if (initialSessionResumeStartedRef.current) return;
    const targetSessionId = selectInitialSessionId(sessionId, continueSession ?? false, recentSessions);
    if (!targetSessionId) return;
    initialSessionResumeStartedRef.current = true;
    void resumeSession(targetSessionId);
  }, [sessionId, continueSession, recentSessions, resumeSession]);

  // -- Title generation (after askQuestion and submitCommand are available) --
  useTitleGeneration({
    messages,
    currentModel: currentModel ?? '',
    resolvedApiKeys,
    isSwitchingSession,
    toolStateIsProcessing: toolState.state.isProcessing,
    sessionTitle,
    setSessionTitle,
    sessionTitleRef,
    titleGenerationInFlightRef,
    titleGenerationDoneRef,
    findProviderForModel,
    createProvider: createTitleProvider,
  });

  // -- Stable screen navigation callbacks for command palette --
  const navigateScreen = useCallback(
    (screen: string) => {
      // Clear terminal buffer when switching back to chat from other screens
      // to prevent ghost content from previous screens
      if (screen === 'chat' && activeScreenRef.current !== 'chat') {
        process.stdout.write('\x1b[2J\x1b[0f');
      }
      setActiveScreen(screen as ScreenType);
    },
    [setActiveScreen]
  );
  const searchPromptHistory = useCallback((query: string) => sessionManager.searchUserPrompts(query), [sessionManager]);
  const handleHeaderNavigate = useCallback((screen: string) => {
    if (screen === 'models') {
      setModelPickerPhase('models');
      setCatalogModels(listCatalogModels(resolvedApiKeys));
      void refreshModels().then((updated) => {
        if (updated) setCatalogModels(listCatalogModels(resolvedApiKeys));
      });
    }
    navigateScreen(screen);
  }, [navigateScreen, resolvedApiKeys, refreshModels]);
  const navigateToTranscript = useCallback(() => setActiveScreen('transcript'), [setActiveScreen]);

  // -- Handle permission card choices --
  const handleApprovalKey = useCallback(
    (choice: number) => {
      const pendingApproval = toolState.state.pendingApprovals[0];
      if (pendingApproval) {
        if (choice === 1) {
          setExecutionMode('auto-approve');
          agentLoop?.setExecutionMode('auto-approve');
          toolState.approveTool(pendingApproval.toolName);
        } else if (choice === 2) {
          toolState.approveTool(pendingApproval.toolName);
        } else if (choice === 3) {
          toolState.rejectTool(pendingApproval.toolName);
        }
      }
    },
    [toolState, agentLoop]
  );

  // -- Handle question selection (number keys 1-9) --
  const handleQuestionSelect = useCallback(
    (optionIndex: number) => {
      if (pendingQuestion && pendingQuestion.options[optionIndex]) {
        resolvePendingQuestion(pendingQuestion.options[optionIndex].value);
      }
    },
    [pendingQuestion, resolvePendingQuestion]
  );

  // -- Handle question rejection (Escape) --
  const handleQuestionReject = useCallback(() => {
    resolvePendingQuestion(null);
  }, [resolvePendingQuestion]);

  // -- Keyboard shortcuts for Alt+letter navigation --
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [selectedMCPIndex, setSelectedMCPIndex] = useState(0);
  const [mcpServers, setMcpServers] = useState<
    { name: string; status: 'connected' | 'disconnected' | 'error'; toolCount?: number }[]
  >([]);

  const allModels = catalogModels.map((m) => ({ id: m.id, name: m.name }));
  const mouseBus = useMouseBus();

  useEffect(() => {
    if (!mouseBus) return;
    const scrollList = (event: import('./input/mouse-input.js').MouseInputEvent) => {
      if (event.kind !== 'wheel' || !event.direction) return;
      const delta = event.direction === 'up' ? -1 : event.direction === 'down' ? 1 : 0;
      if (!delta) return;
      if (activeScreen === 'sessions' && recentSessions.length) {
        setSelectedSessionIndex((index) => Math.max(0, Math.min(recentSessions.length - 1, index + delta)));
      } else if (activeScreen === 'models' && allModels.length) {
        setSelectedModelIndex((index) => Math.max(0, Math.min(allModels.length - 1, index + delta)));
      } else if (activeScreen === 'mcp' && mcpServers.length) {
        setSelectedMCPIndex((index) => Math.max(0, Math.min(mcpServers.length - 1, index + delta)));
      }
    };
    mouseBus.on('mouse', scrollList);
    return () => { mouseBus.off('mouse', scrollList); };
  }, [mouseBus, activeScreen, recentSessions.length, allModels.length, mcpServers.length]);

  const applyModelSelection = useCallback(
    (modelId: string) => {
      handleSetCurrentModel(modelId);
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Model set to: ${modelId}`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
      if (agentLoop) {
        agentLoop.switchModel(modelId);
      } else {
        void bootstrapAgent(resolvedApiKeys, undefined, undefined);
      }
      setActiveScreen('chat');
      setModelPickerPhase('models');
      setPendingEffortModelId(null);
    },
    [agentLoop, bootstrapAgent, handleSetCurrentModel, resolvedApiKeys]
  );

  useKeyboardShortcuts({
    agentLoop,
    onEscapeWithQueue: () => {
      // A queued message typed during the run is the user's steering input.
      // Submit it as one follow-up after the cancelled prompt settles.
      setQueuedMessages((pending) => {
        const active = pending.filter((message) => message.status === 'sending');
        const steering = pending.filter((message) => message.status !== 'sending');
        if (steering.length === 0) return pending;
        return [
          ...active,
          createQueuedPrompt(steering.map((message) => message.text).join('\n\n'), activeSessionId),
        ];
      });
    },
    onNavigate: (screen) => {
      if (screen === 'models') {
        setModelPickerPhase('models');
        setCatalogModels(listCatalogModels(resolvedApiKeys));
        void refreshModels().then((updated) => {
          if (updated) setCatalogModels(listCatalogModels(resolvedApiKeys));
        });
      }
      navigateScreen(screen);
    },
    activeScreen,
    currentMode: executionMode,
    isProcessing: toolState.state.isProcessing,
    showSuggestions: false,
    hasPendingApproval: toolState.state.pendingApprovals.length > 0,
    hasPendingQuestion: Boolean(pendingQuestion),
    onModeChange: applyExecutionMode,
    onApprovalKey: handleApprovalKey,
    onQuestionSelect: handleQuestionSelect,
    onQuestionReject: handleQuestionReject,
    onBlockInput: (ms: number) => {
      inputBlockedRef.current = true;
      setTimeout(() => {
        inputBlockedRef.current = false;
      }, ms);
    },
    sessions: recentSessions.map((s) => ({ id: s.id, title: s.title })),
    selectedSessionIndex,
    onSessionIndexChange: setSelectedSessionIndex,
    onSessionSelect: () => {
      const session = recentSessions[selectedSessionIndex];
      if (session) {
        setActiveScreen('chat');
        void resumeSession(session.id);
      }
    },
    models: allModels,
    selectedModelIndex,
    onModelIndexChange: setSelectedModelIndex,
    modelPickerPhase,
    effortOptionCount: EFFORT_LEVELS.length,
    selectedEffortIndex: effortIndex,
    onEffortIndexChange: setEffortIndex,
    onEffortSelect: () => {
      const level = EFFORT_LEVELS[effortIndex] ?? 'none';
      setEffort(level);
      if (pendingEffortModelId) {
        applyModelSelection(pendingEffortModelId);
      } else {
        setActiveScreen('chat');
        setModelPickerPhase('models');
      }
    },
    onEffortSkip: () => {
      if (pendingEffortModelId) {
        applyModelSelection(pendingEffortModelId);
      } else {
        setActiveScreen('chat');
        setModelPickerPhase('models');
      }
    },
    onModelConnect: () => {
      const model = catalogModels[selectedModelIndex];
      if (!model) return;
      setPendingConnectProvider(model.provider);
      setActiveScreen('chat');
      setModelPickerPhase('models');
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Enter API key for ${model.provider}. Press Enter to save or type /cancel to abort.`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
    },
    onModelSelect: () => {
      const model = catalogModels[selectedModelIndex];
      if (!model) return;
      if (!model.hasKey) {
        setPendingConnectProvider(model.provider);
        setActiveScreen('chat');
        setModelPickerPhase('models');
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `Enter API key for ${model.provider}. Press Enter to save or type /cancel to abort.`,
            timestamp: new Date(),
            commandOutput: true,
          },
        ]);
        return;
      }
      if (model.supportsEffort) {
        setPendingEffortModelId(model.id);
        setModelPickerPhase('effort');
        const idx = EFFORT_LEVELS.indexOf(effort);
        setEffortIndex(idx >= 0 ? idx : 0);
        return;
      }
      applyModelSelection(model.id);
    },
    mcpServers,
    selectedMCPIndex,
    onMCPIndexChange: setSelectedMCPIndex,
    onMCPSelect: () => {
      const server = mcpServers[selectedMCPIndex];
      if (server) {
        // Toggle connection - for now just show a message
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content:
              server.status === 'connected'
                ? `Disconnecting from ${server.name}...`
                : `Connecting to ${server.name}...`,
            timestamp: new Date(),
            commandOutput: true,
          },
        ]);
      }
    },
    onHistoryPageUp: () => {
      if (activeScreen === 'chat' && viewport.pageSize > 0 && !toolState.state.isProcessing) {
        viewport.pageUp();
      }
    },
    onHistoryPageDown: () => {
      if (activeScreen === 'chat' && viewport.pageSize > 0 && !toolState.state.isProcessing) {
        viewport.pageDown();
      }
    },
    onHistoryLineUp: () => {
      if (
        activeScreen === 'chat' &&
        viewport.maxScrollOffset > 0 &&
        !toolState.state.isProcessing
      ) {
        viewport.lineUp();
      }
    },
    onHistoryLineDown: () => {
      if (
        activeScreen === 'chat' &&
        viewport.maxScrollOffset > 0 &&
        !toolState.state.isProcessing
      ) {
        viewport.lineDown();
      }
    },
    onHistoryJumpTop: () => {
      if (
        activeScreen === 'chat' &&
        viewport.maxScrollOffset > 0 &&
        !toolState.state.isProcessing
      ) {
        viewport.jumpTop();
      }
    },
    onHistoryJumpBottom: () => {
      if (activeScreen === 'chat' && !toolState.state.isProcessing) {
        viewport.jumpBottom();
      }
    },
    onToggleTimeline: () => setShowTimeline((prev) => !prev),
    onUndo: () => {
      if (activeSessionId) {
        void import('../core/undo-redo.js').then(({ getUndoRedoManager }) => {
          const undoRedo = getUndoRedoManager();
          const result = undoRedo.undo(config.cwd, activeSessionId);
          setUndoCount(undoRedo.getUndoCount());
          setRedoCount(undoRedo.getRedoCount());
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: result.message,
              timestamp: new Date(),
              commandOutput: true,
            },
          ]);
        });
      }
    },
    onRedo: () => {
      if (activeSessionId) {
        void import('../core/undo-redo.js').then(({ getUndoRedoManager }) => {
          const undoRedo = getUndoRedoManager();
          const result = undoRedo.redo(config.cwd, activeSessionId);
          setUndoCount(undoRedo.getUndoCount());
          setRedoCount(undoRedo.getRedoCount());
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: result.message,
              timestamp: new Date(),
              commandOutput: true,
            },
          ]);
        });
      }
    },
  });

  // -- Command palette entries (needs submitCommand) --
  const submitPaletteCommand = useCallback(async (text: string) => {
    await submitCommand(text);
  }, [submitCommand]);
  const commandPaletteEntries = useAppCommandPalette({
    onSetScreen: navigateScreen,
    onClearSession: clearToNewSession,
    onToggleTranscript: navigateToTranscript,
    recentSessions,
    onResumeSession: resumeSession,
    subagentSuggestions,
    onSetInput: useCallback((v: string) => inputRef.current?.setValue(v), []),
    executionMode,
    onApplyExecutionMode: applyExecutionMode,
    onSubmitCommand: submitPaletteCommand,
    activeScreen,
  });

  // -- Sync command palette entries --
  useEffect(() => {
    setCommandPaletteItems(commandPaletteEntries);
  }, [commandPaletteEntries, setCommandPaletteItems]);

  // -- Session auto-save --
  const { forceSave } = useSessionAutoSave({
    sessionManager,
    loadRecentSessions: sessionManagerHook.loadRecentSessions,
    agentLoop,
    activeSessionId,
    messages,
    sessionTitle,
    sessionCreatedAt,
    currentModel: currentModel ?? '',
    executionMode,
    effort,
    isSwitchingSession,
    cwd: config.cwd,
  });

  // Populate the ref for use in quit shortcut handler
  forceSaveRef.current = forceSave;

  // -- Message queue drain --
  useMessageQueueDrain({
    queuedMessages,
    setQueuedMessages,
    commandInFlightRef,
    pendingQuestion,
    pendingConnectProvider,
    agentWizard,
    toolStateIsProcessing: toolState.state.isProcessing,
    pendingApprovalCount: toolState.state.pendingApprovals.length,
    submitCommand,
    blocked: isLoadingApiKeys || isBootstrapping,
  });

  // -- Stable callbacks for JSX handlers --

  const handleBack = useCallback(() => {
    setActiveScreen('chat');
  }, [setActiveScreen]);

  const handleEditQueuedMessage = useCallback((id: string) => {
    const queued = queuedMessages.find((message) => message.id === id);
    if (!queued || queued.status === 'sending') return;
    setQueuedMessages((pending) => pending.filter((message) => message.id !== id));
    inputRef.current?.setValue(queued.text);
  }, [queuedMessages, setQueuedMessages]);

  const handleRemoveQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((pending) => pending.filter((message) => message.id !== id));
  }, [setQueuedMessages]);

  const handleRetryQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((pending) => pending.map((message) => message.id === id
      ? { ...message, status: 'queued', error: undefined }
      : message));
  }, [setQueuedMessages]);

  const handleSplitClose = useCallback(() => {
    setSplitMode(false);
  }, []);

  const handleModelSelect = useCallback(
    (modelId: string) => {
      handleSetCurrentModel(modelId);
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `└─ Model set to: ${modelId}`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
      if (agentLoop) {
        const result = agentLoop.switchModel(modelId);
        if (!result.success) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: `Model switch warning: ${result.error}`,
              timestamp: new Date(),
            },
          ]);
        }
      } else {
        void bootstrapAgent(resolvedApiKeys, undefined, undefined);
      }
      setActiveScreen('chat');
    },
    [handleSetCurrentModel, setMessages, agentLoop, bootstrapAgent, resolvedApiKeys, setActiveScreen]
  );

  const handleEffortSelectSplit = useCallback(
    (level: EffortLevel) => {
      setEffort(level);
      if (pendingEffortModelId) {
        applyModelSelection(pendingEffortModelId);
      }
    },
    [setEffort, pendingEffortModelId, applyModelSelection]
  );

  const handleEffortSelectModels = useCallback(
    (level: EffortLevel) => {
      setEffort(level);
      if (pendingEffortModelId) {
        applyModelSelection(pendingEffortModelId);
      } else {
        setActiveScreen('chat');
        setModelPickerPhase('models');
      }
    },
    [setEffort, pendingEffortModelId, applyModelSelection, setActiveScreen, setModelPickerPhase]
  );

  const handleConnectProviderSplit = useCallback(
    (provider: string) => {
      setPendingConnectProvider(provider);
      setSplitMode(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Enter API key for ${provider}. Press Enter to save or type /cancel to abort.`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
    },
    [setPendingConnectProvider, setSplitMode, setMessages]
  );

  const handleConnectProviderModels = useCallback(
    (provider: string) => {
      setPendingConnectProvider(provider);
      setActiveScreen('chat');
      setModelPickerPhase('models');
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Enter API key for ${provider}. Press Enter to save or type /cancel to abort.`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
    },
    [setPendingConnectProvider, setActiveScreen, setModelPickerPhase, setMessages]
  );

  const handleModelsLoaded = useCallback(
    (models: CatalogModel[]) => {
      setCatalogModels(models);
      if (selectedModelIndex >= models.length) {
        setSelectedModelIndex(Math.max(0, models.length - 1));
      }
    },
    [setCatalogModels, selectedModelIndex, setSelectedModelIndex]
  );

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      setActiveScreen('chat');
      void resumeSession(sessionId);
    },
    [setActiveScreen, resumeSession]
  );

  const handleLoadSessions = useCallback((): Promise<void> => {
    return sessionManagerHook.loadRecentSessions();
  }, [sessionManagerHook.loadRecentSessions]);

  const handleMCPConnect = useCallback(
    (serverName: string) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Connecting to ${serverName}...`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
    },
    [setMessages]
  );

  const handleMCPDisconnect = useCallback(
    (serverName: string) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Disconnecting from ${serverName}...`,
          timestamp: new Date(),
          commandOutput: true,
        },
      ]);
    },
    [setMessages]
  );

  const handleMCPSelect = useCallback(
    (serverName: string) => {
      const server = mcpServers.find((s) => s.name === serverName);
      if (server) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content:
              server.status === 'connected'
                ? `Disconnecting from ${serverName}...`
                : `Connecting to ${serverName}...`,
            timestamp: new Date(),
            commandOutput: true,
          },
        ]);
      }
    },
    [setMessages, mcpServers]
  );

  const handleStopProcessing = useCallback(() => {
    toolState.stopProcessing();
  }, [toolState]);

  // ---------------------------------------------------------------------------
  // JSX Layout
  // ---------------------------------------------------------------------------

  return (
    <ErrorBoundary>
      <Box flexDirection="column" height={terminalSize.height} width={terminalSize.width}>
        <Box flexDirection="column" ref={chromeRef} flexShrink={0}>
          <HeaderNav
            activeScreen={activeScreen}
            onNavigate={handleHeaderNavigate}
          />
        </Box>

        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {activeScreen === 'chat' ? (
            <SplitPaneLayout
              splitActive={splitMode}
              leftPane={
                <Box flexDirection="row" width={viewport.viewportWidth} height={mainAreaHeight}>
                  <MouseRegion
                    width={showTimeline
                      ? Math.floor(viewport.viewportWidth * 0.75)
                      : splitMode
                        ? Math.floor(viewport.viewportWidth / 2)
                        : viewport.viewportWidth}
                    height={mainAreaHeight}
                    flexGrow={0}
                    onWheel={(direction) => {
                      if (direction === 'up') viewport.lineUp();
                      if (direction === 'down') viewport.lineDown();
                    }}
                  >
                  <ChatViewport
                    messages={chatHistory}
                    width={
                      showTimeline
                        ? Math.floor(viewport.viewportWidth * 0.75)
                        : splitMode
                          ? Math.floor(viewport.viewportWidth / 2)
                          : viewport.viewportWidth
                    }
                    height={mainAreaHeight}
                    scrollOffset={viewport.scrollOffset}
                    bottomPadding={0}
                    onScrollOffsetChange={viewport.setScrollOffset}
                  />
                  {showTimeline && (
                    <TimelineSidebar
                      messages={chatHistory}
                      width={Math.floor(viewport.viewportWidth * 0.25)}
                      height={mainAreaHeight}
                      selectedIndex={selectedTimelineIndex}
                      onSelect={(index, messageIndex) => {
                        setSelectedTimelineIndex(index);
                        if (messageIndex !== undefined) viewport.jumpToMessage(messageIndex);
                      }}
                    />
                  )}
                  </MouseRegion>
                </Box>
              }
              rightPane={
                <StandaloneScreenRenderer
                  activeScreen={rightScreen}
                  onBack={handleSplitClose}
                  workspaceDir={config.cwd}
                  selectedMarketSymbol={selectedMarketSymbol}
                  onSelectedMarketSymbolChange={setSelectedMarketSymbol}
                  terminalSize={{
                    width: Math.floor(terminalSize.width / 2),
                    height: mainAreaHeight,
                  }}
                  currentModel={currentModel ?? undefined}
                  apiKeys={resolvedApiKeys}
                  selectedModelIndex={selectedModelIndex}
                  currentEffort={effort}
                  effortIndex={effortIndex}
                  modelPickerPhase={modelPickerPhase}
                  pendingModelId={pendingEffortModelId}
                  onEffortSelect={handleEffortSelectSplit}
                  onConnectProvider={handleConnectProviderSplit}
                  onModelsLoaded={handleModelsLoaded}
                  onModelSelect={handleModelSelect}
                />
              }
              terminalWidth={terminalSize.width}
              terminalHeight={mainAreaHeight}
            />
          ) : activeScreen === 'transcript' ? (
              <TranscriptScreen
                messages={messages}
                width={viewport.viewportWidth}
                height={mainAreaHeight}
                showAll={showAllInTranscript}
                onScroll={viewport.setScrollOffset}
              />
          ) : activeScreen === 'sessions' ? (
            <SessionPickerModal
              sessions={recentSessions.map((s) => ({
                id: s.id,
                title: s.title,
                updatedAt: s.updatedAt,
              }))}
              onSelect={handleSessionSelect}
              onClose={handleBack}
              onLoadSessions={handleLoadSessions}
              height={mainAreaHeight}
              width={terminalSize.width}
              selectedIndex={selectedSessionIndex}
              onSelectedIndexChange={setSelectedSessionIndex}
            />
          ) : activeScreen === 'models' ? (
              <ModelsScreen
                currentModel={currentModel ?? ''}
                apiKeys={resolvedApiKeys}
                selectedIndex={selectedModelIndex}
                onSelectedIndexChange={setSelectedModelIndex}
                currentEffort={effort}
                effortIndex={effortIndex}
                phase={modelPickerPhase}
                pendingModelId={pendingEffortModelId}
                onEffortSelect={handleEffortSelectModels}
                onConnectProvider={handleConnectProviderModels}
                onModelsLoaded={handleModelsLoaded}
                onSelect={handleModelSelect}
                onBack={handleBack}
                height={mainAreaHeight}
                width={terminalSize.width}
              />
          ) : activeScreen === 'mcp' ? (
              <MCPScreen
                servers={mcpServers.map((s) => ({
                  name: s.name,
                  command: '',
                  args: [],
                  status: s.status,
                  toolCount: s.toolCount,
                }))}
                onConnect={handleMCPConnect}
                onDisconnect={handleMCPDisconnect}
                onSelect={handleMCPSelect}
                onBack={handleBack}
                selectedIndex={selectedMCPIndex}
                onSelectedIndexChange={setSelectedMCPIndex}
              />
          ) : (
            <Box flexDirection="column" overflow="hidden">
              <ScreenRouter
                activeScreen={activeScreen}
                onBack={handleBack}
                workspaceDir={config.cwd}
                selectedMarketSymbol={selectedMarketSymbol}
                onSelectedMarketSymbolChange={setSelectedMarketSymbol}
                terminalSize={terminalSize}
                currentModel={currentModel ?? undefined}
                apiKeys={resolvedApiKeys}
                onModelSelect={handleModelSelect}
                onSelectedModelIndexChange={setSelectedModelIndex}
              />
            </Box>
          )}
        </Box>

        <Box flexDirection="column" ref={footerRef} width={terminalSize.width} flexShrink={0}>
          {activeScreen === 'chat' ? (
            <>
              {/* Layer 1: Thinking animation and approval/question prompts */}
              {/* Height varies: 1 for approval only, 5+ for questions */}
              {pendingQuestion ? (
                <Box marginTop={SPACING.xs} flexDirection="column" width={terminalSize.width}>
                  <ChatStatusBanner
                    position="top"
                    terminalWidth={terminalSize.width}
                    pendingQuestion={{
                      question: pendingQuestion.question,
                      options: pendingQuestion.options,
                    }}
                    isProcessing={toolState.state.isProcessing}
                    queuedMessages={queuedMessages}
                  />
                </Box>
              ) : (
                <Box marginTop={SPACING.xs} flexDirection="column" width={terminalSize.width}>
                  {toolState.state.isProcessing && (
                    <Box height={1} width={terminalSize.width}>
                      <ThinkingAnimation
                        activeTools={toolState.state.activeTools}
                        width={terminalSize.width}
                      />
                    </Box>
                  )}
                  {toolState.state.pendingApprovals.length > 0 && (
                    <Box width={terminalSize.width}>
                      <ChatStatusBanner
                        position="top"
                        terminalWidth={terminalSize.width}
                        terminalHeight={terminalSize.height}
                        compact={true}
                        pendingApprovalToolName={toolState.state.pendingApprovals[0]?.toolName}
                        pendingApprovalInput={toolState.state.pendingApprovals[0]?.input}
                        pendingApprovalReason={toolState.state.pendingApprovals[0]?.reason}
                        onApprovalSelect={handleApprovalKey}
                        isProcessing={toolState.state.isProcessing}
                        queuedMessages={queuedMessages}
                      />
                    </Box>
                  )}
                </Box>
              )}

              {(queuedMessages.length > 0 || (toolState.state.isProcessing && !pendingQuestion)) && (
                <Box marginTop={SPACING.xs} width={terminalSize.width}>
                  <ChatStatusBanner
                    position="bottom"
                    terminalWidth={terminalSize.width}
                    terminalHeight={terminalSize.height}
                    isProcessing={toolState.state.isProcessing}
                    queuedMessages={queuedMessages}
                    onEditQueuedMessage={handleEditQueuedMessage}
                    onRemoveQueuedMessage={handleRemoveQueuedMessage}
                    onRetryQueuedMessage={handleRetryQueuedMessage}
                  />
                </Box>
              )}

              {/* Layer 2: Command input line - hidden when question is active */}
              {!pendingQuestion && (
                <Box marginTop={SPACING.xs} flexDirection="column">
                  {/* Double Ctrl+C warning indicator */}
                  {quitShortcutArmed && (
                    <Box marginBottom={SPACING.xs}>
                      <Text color="yellow">Press Ctrl+C again to exit (or continue typing)</Text>
                    </Box>
                  )}
                  <CommandInput
                    ref={inputRef}
                    onSubmit={handleSubmit}
                    searchPrompts={searchPromptHistory}
                    onStopProcessing={handleStopProcessing}
                    placeholder={getInputPlaceholder({
                      pendingConnectProvider,
                      agentWizard,
                      pendingQuestion,
                      pendingApprovalCount: toolState.state.pendingApprovals.length,
                      isProcessing: toolState.state.isProcessing,
                      queuedMessageCount: queuedMessages.length,
                    })}
                    agentSuggestions={subagentSuggestions}
                    executionMode={executionMode}
                    disabled={isCommandPaletteOpen || toolState.state.pendingApprovals.length > 0}
                    inputBlockedRef={inputBlockedRef}
                    isProcessing={toolState.state.isProcessing}
                    hasPendingApproval={toolState.state.pendingApprovals.length > 0}
                  />
                </Box>
              )}

              {/* Layer 3: Notifications */}
              <NotificationToast />

              {/* Layer 4: Status line - hidden when question is active */}
              {!pendingQuestion && (
                <Box marginTop={0}>
                  <StatusLine
                    executionMode={executionMode}
                    currentModel={currentModel ?? undefined}
                    currentEffort={effort}
                    isProcessing={false}
                    workspaceAgentCount={workspaceAgentCount}
                    activeTools={toolState.state.activeTools}
                    gitStatus={gitStatus}
                    contextUsage={contextUsage}
                    cwd={config.cwd}
                    undoCount={undoCount}
                    redoCount={redoCount}
                    queueCount={queuedMessages.length}
                    autoLintErrors={autoLintErrors}
                  />
                </Box>
              )}
            </>
          ) : (
            <>
              {/* Non-chat screens: still show status line + minimal input hint */}
              <Box marginTop={SPACING.xs}>
                <StatusLine
                  executionMode={executionMode}
                  currentModel={currentModel ?? undefined}
                  currentEffort={effort}
                  isProcessing={false}
                  workspaceAgentCount={workspaceAgentCount}
                  activeTools={toolState.state.activeTools}
                  gitStatus={gitStatus}
                  contextUsage={contextUsage}
                  cwd={config.cwd}
                  undoCount={undoCount}
                  redoCount={redoCount}
                  queueCount={queuedMessages.length}
                  autoLintErrors={autoLintErrors}
                />
              </Box>
              <Box marginTop={0}>
                <Text dimColor>Esc returns to chat. Ctrl+K opens the command palette.</Text>
              </Box>
            </>
          )}

          {isCommandPaletteOpen && (
            <Box marginTop={SPACING.xs}>
              <CommandPaletteView />
            </Box>
          )}
        </Box>
      </Box>
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// App (provider wrapper)
// ---------------------------------------------------------------------------

export function App({ apiKeys, config, initialPrompt }: AppProps) {
  const privateKey = process.env.PRIVATE_KEY;
  const mainAddress = process.env.MAIN_ADDRESS;

  return (
    <WalletProvider privateKey={privateKey} mainAddress={mainAddress}>
      <ToolStateProvider>
        <ModelStateProvider initialModel={config.model ?? null}>
          <SessionStateProvider>
            <AppContent apiKeys={apiKeys} config={config} initialPrompt={initialPrompt} />
          </SessionStateProvider>
        </ModelStateProvider>
      </ToolStateProvider>
    </WalletProvider>
  );
}

