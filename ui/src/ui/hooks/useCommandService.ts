import { useMemo, useCallback, useRef } from 'react';
import type {
  AgentLoop,
  ExecutionMode,
  QuestionPrompt,
  SubagentRegistry,
  Message as CoreMessage,
} from '../../index.js';
import type { Message } from '../types.js';
import type { ScreenType, AgentWizardState } from './useState/useUIState.js';
import { CommandService } from '../../services/CommandService.js';
import { deriveCoreConversation } from '../utils/chatHelpers.js';
import { createDefaultToolRegistry } from '../../index.js';

interface UseCommandServiceOptions {
  agentLoop: AgentLoop | null;
  subagentRegistry: SubagentRegistry | null;
  cwd: string;
  activeSessionId: string;
  appendChatMessage: (message: Message) => void;
  toolState: {
    startProcessing: (isProcessing?: boolean) => void;
    setCurrentTool: (tool: string | null) => void;
    setActiveTools: (tools: string[]) => void;
    stopProcessing: () => void;
    state: {
      pendingApprovals: Array<{ toolName?: string }>;
    };
  };
  setActiveScreen: React.Dispatch<React.SetStateAction<ScreenType>>;
  setPendingConnectProvider: React.Dispatch<React.SetStateAction<string | null>>;
  setAgentWizard: React.Dispatch<React.SetStateAction<AgentWizardState | null>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  clearToNewSession: () => Promise<void>;
  loadRecentSessionsText: () => Promise<string>;
  resumeSession: (sessionId: string) => Promise<{ success: boolean; message: string }>;
  askQuestionRef: React.MutableRefObject<(prompt: QuestionPrompt) => Promise<string | null>>;
  pendingQuestionRef: React.MutableRefObject<unknown>;
  commandInFlightRef: React.MutableRefObject<boolean>;
  messagesRef: React.MutableRefObject<Message[]>;
  refreshApiKeys: () => Promise<Record<string, string>>;
  bootstrapAgent: (
    keys: Record<string, string>,
    messages?: CoreMessage[],
    mode?: ExecutionMode
  ) => Promise<void>;
  resolvedApiKeys: Record<string, string>;
  setCurrentModel: (model: string) => void;
  onShowSessionPicker: () => void;
  currentModel: string | null;
  currentEffort?: string;
  onEffortChange?: (effort: string) => void;
}

/**
 * Creates the CommandService instance and a submitCommand callback.
 *
 * Encapsulates the command service initialization and the
 * submit/finally pattern for command execution.
 *
 * NOTE: toolState is intentionally excluded from the useMemo dependency
 * array. The toolState object changes on every render when state changes,
 * which would recreate the CommandService and cascade instability through
 * submitCommand -> useMessageQueueDrain -> useInputHandler. Instead, we
 * use refs for the callbacks that need the latest toolState values.
 */
export function useCommandService(options: UseCommandServiceOptions) {
  const {
    agentLoop,
    subagentRegistry,
    cwd,
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
    setCurrentModel,
    resolvedApiKeys,
    onShowSessionPicker,
    currentModel,
    currentEffort,
    onEffortChange,
  } = options;

  // Use refs for toolState callbacks so CommandService doesn't need to
  // be recreated when toolState changes.
  const toolStateRef = useRef(toolState);
  toolStateRef.current = toolState;

  const resolvedApiKeysRef = useRef(resolvedApiKeys);
  resolvedApiKeysRef.current = resolvedApiKeys;

  const commandService = useMemo(
    () =>
      new CommandService({
        agentLoop: agentLoop ?? undefined,
        subagentRegistry: subagentRegistry ?? undefined,
        toolRegistry: createDefaultToolRegistry(cwd),
        cwd,
        getConversationId: () => activeSessionId,
        onMessage: appendChatMessage,
        onProcessingChange: (isProcessing?: boolean) =>
          toolStateRef.current.startProcessing(isProcessing),
        onToolChange: (tool: string | null) => toolStateRef.current.setCurrentTool(tool),
        onModelChange: setCurrentModel,
        onEffortChange,
        getApiKeys: () => resolvedApiKeysRef.current,
        onActiveToolsChange: (tools: string[]) => toolStateRef.current.setActiveTools(tools),
        onNavigate: (screen) => setActiveScreen(screen as ScreenType),
        onConnectProvider: (provider) => setPendingConnectProvider(provider),
        onClearSession: clearToNewSession,
        onListSessions: loadRecentSessionsText,
        onResumeSession: resumeSession,
        onQuestionRequired: (prompt: QuestionPrompt) => askQuestionRef.current(prompt),
        onStartAgentCreate: () => {
          setAgentWizard({ step: 'name', data: {} });
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: 'Creating a workspace agent. Enter agent name or /cancel to abort.',
              timestamp: new Date(),
            },
          ]);
        },
        onAuthChanged: async () => {
          const nextKeys = await refreshApiKeys();
          await bootstrapAgent(
            nextKeys,
            agentLoop?.getConversation() ?? deriveCoreConversation(messagesRef.current)
          );
        },
        onSubagentsChanged: async () => {
          await bootstrapAgent(
            resolvedApiKeysRef.current,
            agentLoop?.getConversation() ?? deriveCoreConversation(messagesRef.current)
          );
        },
        onShowSessionPicker: onShowSessionPicker,
        currentModel,
        currentEffort,
      }),
    [
      activeSessionId,
      agentLoop,
      appendChatMessage,
      bootstrapAgent,
      clearToNewSession,
      cwd,
      loadRecentSessionsText,
      refreshApiKeys,
      resumeSession,
      subagentRegistry,
      onShowSessionPicker,
      currentModel,
      currentEffort,
      onEffortChange,
      // toolState intentionally excluded -- accessed via ref
      // resolvedApiKeys intentionally excluded -- accessed via ref
    ]
  );

  const submitCommand = useCallback(
    async (text: string) => {
      commandInFlightRef.current = true;
      try {
        await commandService.executeCommand(text);
      } finally {
        commandInFlightRef.current = false;
        if (
          toolStateRef.current.state.pendingApprovals.length === 0 &&
          !pendingQuestionRef.current
        ) {
          toolStateRef.current.stopProcessing();
        }
      }
    },
    [commandService]
    // toolState and pendingQuestionRef intentionally excluded -- accessed via ref
  );

  return { commandService, submitCommand };
}
