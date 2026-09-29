import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { getDynamindPath } from '../utils/constants.js';
import { setSessionInfoForExit } from '../cli.js';
import { WalletProvider } from '../contexts/WalletContext.js';
import { ToolStateProvider, useToolState } from '../services/ToolStateManagerProvider.js';
import { createAgentLoopEventHandler } from '../services/ToolStateManager.js';
import { TranscriptScreen } from './screens/TranscriptScreen.js';
import { useCommandPalette } from './common/CommandPalette.js';
import { StatusLine } from './common/StatusLine.js';
import ThinkingAnimation from './common/ThinkingAnimation.js';
import {
  AgentLoop,
  createProvider,
  createSystemPrompt,
  findProviderForModel,
  listCatalogModels,
  refreshModels,
  EFFORT_LEVELS,
  type EffortLevel,
  type CatalogModel,
  SessionManager,
  saveLastModel,
  loadConfig,
  type AgentEvent,
  type ExecutionMode,
  type QuestionPrompt,
} from '../index.js';
import {
  ModelStateProvider,
  useModelState,
  SessionStateProvider,
  useSessionState,
} from './contexts/AppStateContext.js';
import { HeaderNav } from './common/HeaderNav.js';
import { CommandInput, type CommandInputHandle } from './common/CommandInput.js';
import { ErrorBoundary } from './common/ErrorBoundary.js';
import { ChatViewport } from './common/ChatViewport.js';
import { ChatStatusBanner } from './common/ChatStatusBanner.js';
import { SessionPickerModal } from './common/SessionPickerModal.js';
import { ModelsScreen } from './screens/ModelsScreen.js';
import { MCPScreen } from './screens/MCPScreen.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useChatViewport } from './hooks/useChatViewport.js';
import { useStatusPolling } from './hooks/useStatusPolling.js';
import { useAgentBootstrap } from './hooks/useAgentBootstrap.js';
import { useSessionManager } from './hooks/useSessionManager.js';
import { useInputHandler } from './hooks/useInputHandler.js';
import { useTitleGeneration } from './hooks/useTitleGeneration.js';
import { useAppCommandPalette } from './hooks/useAppCommandPalette.js';
import { useAgentState } from './hooks/useState/useAgentState.js';
import { useUIState, type ScreenType } from './hooks/useState/useUIState.js';
import { useTimelineEventHandler } from './hooks/useTimelineEventHandler.js';
import { useSessionLifecycle } from './hooks/useSessionLifecycle.js';
import { useSessionAutoSave } from './hooks/useSessionAutoSave.js';
import { useMessageQueueDrain } from './hooks/useMessageQueueDrain.js';
import { useLayoutMeasurement } from './hooks/useLayoutMeasurement.js';
import { useCommandService } from './hooks/useCommandService.js';
import { useApiKeys } from './hooks/useApiKeys.js';
import { useChatMessageHelpers } from './hooks/useChatMessageHelpers.js';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js';
import { ScreenRouter, StandaloneScreenRenderer } from './renderers/ScreenRouter.js';
import { SplitPaneLayout } from './layout/SplitPaneLayout.js';
import { TimelineSidebar } from './common/TimelineSidebar.js';
import { NotificationToast } from './common/NotificationToast.js';
import { getInputPlaceholder } from './utils/chatHelpers.js';
import { PROVIDERS } from '../index.js';
import { SPACING } from './design/tokens.js';
import { getCheckpointManager } from '../core/git-checkpoint.js';
import { getUndoRedoManager } from '../core/undo-redo.js';
import { runAutoLint, formatLintResults } from '../core/auto-lint.js';
import { forkSession } from '../core/session-fork.js';
import { exportSession } from '../core/session-export.js';
import { loadCustomCommands } from '../core/custom-commands.js';

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
}

// ---------------------------------------------------------------------------
// AppContent (shell component)
// ---------------------------------------------------------------------------

function AppContent({ apiKeys, config, initialPrompt, sessionId }: AppProps) {
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
    queuedMessages,
    setQueuedMessages,
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
  const { resolvedApiKeys, refreshApiKeys } = useApiKeys(apiKeys);
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

  // -- Refs for exit handling (must be after sessionManagerHook) --
  const sessionTitleForExitRef = useRef(sessionTitle);
  const activeSessionIdForExitRef = useRef(activeSessionId);
  sessionTitleForExitRef.current = sessionTitle;
  activeSessionIdForExitRef.current = activeSessionId;

  // -- Resume session from CLI -s flag --
  useEffect(() => {
    if (sessionId) {
      void resumeSession(sessionId);
    }
  }, [sessionId]);

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
    (event) => handlers.handleEvent(event),
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

  // -- Turn progress (count user messages as turns) --
  const turnNumber = React.useMemo(
    () => messages.filter((m) => m.role === 'user').length,
    [messages]
  );
  const totalTurns = config.maxTurns;

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
  });

  // -- Chat viewport --
  const mainAreaHeight = Math.max(1, terminalSize.height - chromeHeight - footerHeight);
  const chatHistory = React.useMemo(
    () => messages.filter((message) => message.role !== 'system' || message.commandOutput === true),
    [messages]
  );
  const viewport = useChatViewport(chatHistory, terminalSize.width, mainAreaHeight);

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
      agentLoop.setAutoCheckpoint((label: string) => {
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
    submitCommand,
    commandInFlightRef,
    onSetQueuedMessages: setQueuedMessages,
    configCwd: config.cwd,
    commandService,
    createCustomAgent: async (data: Record<string, unknown>) => {
      return (commandService as any).createCustomAgent(data);
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
    createProvider,
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
  const navigateToTranscript = useCallback(() => setActiveScreen('transcript'), [setActiveScreen]);

  // -- Handle approval keypress (y/n) --
  const handleApprovalKey = useCallback(
    (approved: boolean) => {
      const pendingApproval = toolState.state.pendingApprovals[0];
      if (pendingApproval) {
        if (approved) {
          toolState.approveTool(pendingApproval.toolName);
        } else {
          toolState.rejectTool(pendingApproval.toolName);
          agentLoop?.stop();
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
      }
    },
    onRedo: () => {
      if (activeSessionId) {
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
      }
    },
  });

  // -- Command palette entries (needs submitCommand) --
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
    onSubmitCommand: submitCommand,
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
  });

  // -- Stable callbacks for JSX handlers --

  const handleBack = useCallback(() => {
    setActiveScreen('chat');
  }, [setActiveScreen]);

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
          />
        </Box>

        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {activeScreen === 'chat' ? (
            <SplitPaneLayout
              splitActive={splitMode}
              leftPane={
                <Box flexDirection="row" width={viewport.viewportWidth} height={mainAreaHeight}>
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
                    />
                  )}
                </Box>
              }
              rightPane={
                <StandaloneScreenRenderer
                  activeScreen={rightScreen}
                  onBack={handleSplitClose}
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
            />
          ) : (
            <Box flexDirection="column" overflow="hidden">
              <ScreenRouter
                activeScreen={activeScreen}
                onBack={handleBack}
                terminalSize={terminalSize}
                currentModel={currentModel ?? undefined}
                apiKeys={resolvedApiKeys}
                onModelSelect={handleModelSelect}
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
                    <Box height={1} width={terminalSize.width}>
                      <ChatStatusBanner
                        position="top"
                        terminalWidth={terminalSize.width}
                        compact={true}
                        pendingApprovalToolName={toolState.state.pendingApprovals[0]?.toolName}
                        isProcessing={toolState.state.isProcessing}
                        queuedMessages={queuedMessages}
                      />
                    </Box>
                  )}
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
                    turnNumber={turnNumber}
                    totalTurns={totalTurns}
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
                  turnNumber={turnNumber}
                  totalTurns={totalTurns}
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
