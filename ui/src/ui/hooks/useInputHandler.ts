import { useCallback, useRef } from 'react';
import type { QuestionPrompt, QuestionOption } from '../../index.js';
import { createDefaultToolRegistry } from '../../index.js';
import { isShellPassthrough, extractShellCommand, executeShell } from '../../core/shell-passthrough.js';
import { resolveMentions } from '../../core/mention-resolver.js';

interface PendingQuestionState {
  question: string;
  options: QuestionOption[];
  defaultValue?: string;
  /** If true, user can type custom text as option 5 */
  allowCustomText?: boolean;
  resolve: (value: string | null) => void;
}

interface PendingApprovalState {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  resolve: (approved: boolean) => void;
}

interface AgentWizardState {
  step: 'name' | 'description' | 'scope' | 'tools' | 'maxTurns';
  data: Record<string, unknown>;
}

interface ToolState {
  state: {
    pendingApprovals: PendingApprovalState[];
    isProcessing: boolean;
  };
  removePendingApproval: (toolName: string) => void;
  finishToolInHistory: (toolName: string, success: boolean) => void;
}

export interface InputHandlerResult {
  handleSubmit: (text: string) => void;
  resolvePendingApproval: (approved: boolean) => boolean;
  resolvePendingQuestion: (value: string | null) => boolean;
  askQuestion: (prompt: QuestionPrompt) => Promise<string | null>;
}

export function useInputHandler(options: {
  toolState: ToolState;
  pendingQuestionRef: React.MutableRefObject<PendingQuestionState | null>;
  agentWizard: AgentWizardState | null;
  pendingConnectProvider: string | null;
  onSetPendingQuestion: (state: PendingQuestionState | null) => void;
  onSetAgentWizard: (state: AgentWizardState | null) => void;
  onSetPendingConnectProvider: (provider: string | null) => void;
  onSubmitMessage: (text: string) => void;
  inputRef: React.RefObject<{ clear(): void; setValue(v: string): void }>;
  onSetMessages: (updater: (prev: any[]) => any[]) => void;
  resolvedApiKeys: Record<string, string>;
  submitCommand: (text: string) => Promise<void>;
  commandInFlightRef: React.MutableRefObject<boolean>;
  onSetQueuedMessages: (updater: (prev: string[]) => string[]) => void;
  configCwd: string;
  commandService: { submitApiKey: (provider: string, key: string) => Promise<void> };
  createCustomAgent: (
    data: Record<string, unknown>
  ) => Promise<{ success: boolean; message: string }>;
  onAlwaysApprove?: () => void;
}): InputHandlerResult {
  const {
    toolState,
    pendingQuestionRef,
    agentWizard,
    pendingConnectProvider,
    onSetPendingQuestion,
    onSetAgentWizard,
    onSetPendingConnectProvider,
    onSubmitMessage,
    inputRef,
    onSetMessages,
    resolvedApiKeys,
    submitCommand,
    commandInFlightRef,
    onSetQueuedMessages,
    configCwd,
    commandService,
    createCustomAgent,
    onAlwaysApprove,
  } = options;

  const resolvePendingApproval = useCallback(
    (approved: boolean) => {
      const pendingApproval = toolState.state.pendingApprovals[0];
      if (!pendingApproval) {
        return false;
      }

      pendingApproval.resolve(approved);
      toolState.removePendingApproval(pendingApproval.toolName);

      if (!approved) {
        toolState.finishToolInHistory(pendingApproval.toolName, false);
      }

      inputRef.current?.clear();

      return true;
    },
    [toolState, inputRef]
  );

  const resolvePendingQuestion = useCallback(
    (selectedValue: string | null) => {
      const pendingQuestion = pendingQuestionRef.current;
      if (!pendingQuestion) {
        return false;
      }

      pendingQuestion.resolve(selectedValue);
      onSetPendingQuestion(null);
      inputRef.current?.clear();
      return true;
    },
    [pendingQuestionRef, onSetPendingQuestion, inputRef]
  );

  const askQuestion = useCallback(
    async (prompt: QuestionPrompt): Promise<string | null> => {
      if (pendingQuestionRef.current) {
        return null;
      }

      return await new Promise<string | null>((resolve) => {
        onSetPendingQuestion({
          question: prompt.question,
          options: prompt.options,
          defaultValue: prompt.defaultValue,
          allowCustomText: prompt.allowCustomText,
          resolve,
        });
      });
    },
    [pendingQuestionRef, onSetPendingQuestion]
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmedText = text.trim();

      if (!trimmedText) {
        if (pendingQuestionRef.current) {
          const pending = pendingQuestionRef.current;
          if (pending.defaultValue) {
            const matchedDefault = pending.options.find(
              (option) =>
                option.value.toLowerCase() === pending.defaultValue?.toLowerCase() ||
                option.label.toLowerCase() === pending.defaultValue?.toLowerCase()
            );
            if (matchedDefault) {
              resolvePendingQuestion(matchedDefault.value);
              return;
            }
          }

          onSetMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: 'Choose one of the numbered options, or type the exact label/value.',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        return;
      }

      if (pendingQuestionRef.current) {
        const pending = pendingQuestionRef.current;
        const normalized = trimmedText.toLowerCase();

        if (normalized === '/cancel') {
          resolvePendingQuestion(null);
          return;
        }

        const numericChoice = Number.parseInt(trimmedText, 10);
        if (
          Number.isInteger(numericChoice) &&
          numericChoice >= 1 &&
          numericChoice <= pending.options.length
        ) {
          resolvePendingQuestion(pending.options[numericChoice - 1]!.value);
          return;
        }

        // Handle option 5: custom text input
        if (pending.allowCustomText && numericChoice === 5) {
          // If they just type "5", prompt for custom text
          onSetMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: 'Type your custom response and press Enter.',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        const matchedOption = pending.options.find(
          (option) =>
            option.value.toLowerCase() === normalized || option.label.toLowerCase() === normalized
        );
        if (matchedOption) {
          resolvePendingQuestion(matchedOption.value);
          return;
        }

        // If custom text is allowed and no option matched, use the typed text as custom input
        if (pending.allowCustomText && trimmedText.length > 0) {
          resolvePendingQuestion(trimmedText);
          return;
        }

        onSetMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: 'Choose one of the numbered options, or type the exact label/value.',
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (toolState.state.pendingApprovals.length > 0) {
        const normalized = trimmedText.toLowerCase();
        if (normalized === '1') {
          onAlwaysApprove?.();
          resolvePendingApproval(true);
          return;
        }

        if (normalized === '2' || normalized === 'y' || normalized === 'yes') {
          resolvePendingApproval(true);
          inputRef.current?.clear();
          return;
        }

        if (normalized === '3' || normalized === 'n' || normalized === 'no') {
          resolvePendingApproval(false);
          inputRef.current?.clear();
          return;
        }

        onSetMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: 'Choose 1 to always approve, 2 to approve once, or 3 to reject.',
            timestamp: new Date(),
          },
        ]);
        return;
      }

      if (agentWizard) {
        if (trimmedText === '/cancel') {
          onSetAgentWizard(null);
          inputRef.current?.clear();
          onSetMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: 'Cancelled workspace agent creation.',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        switch (agentWizard.step) {
          case 'name': {
            onSetAgentWizard({
              step: 'description',
              data: {
                ...agentWizard.data,
                name: trimmedText,
              },
            });
            inputRef.current?.clear();
            onSetMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: 'Enter a short description for this agent.',
                timestamp: new Date(),
              },
            ]);
            return;
          }

          case 'description': {
            onSetAgentWizard({
              step: 'scope',
              data: {
                ...agentWizard.data,
                description: trimmedText,
              },
            });
            inputRef.current?.clear();
            onSetMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: 'Choose scope: project or global.',
                timestamp: new Date(),
              },
            ]);
            return;
          }

          case 'scope': {
            const normalized = trimmedText.toLowerCase();
            if (normalized !== 'project' && normalized !== 'global') {
              onSetMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: 'Scope must be "project" or "global".',
                  timestamp: new Date(),
                },
              ]);
              return;
            }

            onSetAgentWizard({
              step: 'tools',
              data: {
                ...agentWizard.data,
                scope: normalized,
              },
            });
            inputRef.current?.clear();
            onSetMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: 'Enter comma-separated tools for this agent, or type all.',
                timestamp: new Date(),
              },
            ]);
            return;
          }

          case 'tools': {
            const tools =
              trimmedText.toLowerCase() === 'all'
                ? createDefaultToolRegistry(configCwd).getToolNames()
                : trimmedText
                    .split(',')
                    .map((tool: string) => tool.trim())
                    .filter(Boolean);

            onSetAgentWizard({
              step: 'maxTurns',
              data: {
                ...agentWizard.data,
                tools,
              },
            });
            inputRef.current?.clear();
            onSetMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: 'Enter max turns for this agent as a positive number.',
                timestamp: new Date(),
              },
            ]);
            return;
          }

          case 'maxTurns': {
            const parsedTurns = Number.parseInt(trimmedText, 10);
            if (!Number.isFinite(parsedTurns) || parsedTurns <= 0) {
              onSetMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: 'Max turns must be a positive number.',
                  timestamp: new Date(),
                },
              ]);
              return;
            }

            const wizardData: {
              name?: string;
              description?: string;
              scope?: string;
              tools?: string[];
              maxTurns?: number;
            } = {
              ...agentWizard.data,
              maxTurns: parsedTurns,
            };

            if (!wizardData.name || !wizardData.description || !wizardData.scope) {
              throw new Error('Agent wizard data is incomplete.');
            }

            onSetAgentWizard(null);
            inputRef.current?.clear();

            void createCustomAgent({
              name: wizardData.name,
              description: wizardData.description,
              scope: wizardData.scope,
              tools: wizardData.tools ?? [],
              maxTurns: wizardData.maxTurns,
              visible: true,
            }).then((result: { success: boolean; message: string }) => {
              onSetMessages((prev) => [
                ...prev,
                {
                  role: result.success ? 'assistant' : 'system',
                  content: result.message,
                  timestamp: new Date(),
                },
              ]);
            });

            return;
          }
        }
      }

      // Handle pending connect: user is entering an API key after /connect <provider>
      if (pendingConnectProvider) {
        if (trimmedText === '/cancel') {
          onSetPendingConnectProvider(null);
          inputRef.current?.clear();
          onSetMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: 'Cancelled API key entry.',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        void commandService.submitApiKey(pendingConnectProvider, trimmedText);
        onSetPendingConnectProvider(null);
        inputRef.current?.clear();
        return;
      }

      const connectMatch = trimmedText.match(/^\/connect\s+(\S+)$/i);
      if (connectMatch) {
        const provider = connectMatch[1].toLowerCase();
        onSetMessages((prev) => [
          ...prev,
          {
            role: 'user',
            content: `/connect ${provider}`,
            timestamp: new Date(),
          },
          {
            role: 'system',
            content: `Enter API key for ${provider}. Press Enter to save or type /cancel to abort.`,
            timestamp: new Date(),
          },
        ]);
        onSetPendingConnectProvider(provider);
        inputRef.current?.clear();
        return;
      }

      // Shell passthrough: !command runs shell and injects output
      if (isShellPassthrough(trimmedText)) {
        const shellCmd = extractShellCommand(trimmedText);
        const result = executeShell(shellCmd, configCwd);
        const output = result.stdout || result.stderr || '(no output)';
        onSetMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `[shell]$ ${shellCmd}\n${output}`,
            timestamp: new Date(),
            commandOutput: true,
          },
        ]);
        inputRef.current?.clear();
        return;
      }

      // Resolve @mentions before sending
      const { resolved: resolvedText, mentions } = resolveMentions(trimmedText, configCwd);
      const textToSend = mentions.length > 0 ? resolvedText : trimmedText;

      // Add user message to chat before sending to agent
      // BUT first, prevent rapid submissions by setting the flag
      if (toolState.state.isProcessing || commandInFlightRef.current) {
        // Queue the message if something is already processing
        onSetQueuedMessages((prev) => [...prev, textToSend]);
        inputRef.current?.clear();
        return;
      }

      // Set flag BEFORE adding user message to prevent race conditions
      commandInFlightRef.current = true;

      onSetMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: trimmedText,
          timestamp: new Date(),
        },
      ]);

      // Check if any API key is configured
      const hasAnyKey = Object.values(resolvedApiKeys).some((key) => key && key.length > 0);
      if (!hasAnyKey) {
        commandInFlightRef.current = false;
        onSetMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content:
              'No API key configured. Use /connect <provider> to set one up.\nSupported: /connect anthropic, /connect openai, /connect deepseek, /connect gemini',
            timestamp: new Date(),
          },
        ]);
        inputRef.current?.clear();
        return;
      }

      void submitCommand(textToSend);

      inputRef.current?.clear();
    },
    [
      pendingConnectProvider,
      agentWizard,
      inputRef,
      submitCommand,
      toolState.state.isProcessing,
      toolState.state.pendingApprovals.length,
      pendingQuestionRef,
      resolvePendingQuestion,
      onSetMessages,
      resolvePendingApproval,
      onSetAgentWizard,
      onSetPendingConnectProvider,
      resolvedApiKeys,
      commandInFlightRef,
      onSetQueuedMessages,
      configCwd,
      commandService,
      createCustomAgent,
    ]
  );

  return { handleSubmit, resolvePendingApproval, resolvePendingQuestion, askQuestion };
}
