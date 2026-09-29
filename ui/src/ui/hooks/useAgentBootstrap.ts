import { useState, useCallback, useRef, useEffect, startTransition } from 'react';
import {
  AgentLoop,
  findProviderForModel,
  SubagentRegistry,
  type AgentEvent,
  type Message as CoreMessage,
  type ExecutionMode,
} from '../../index.js';
import { getErrorMessage } from '../../utils/index.js';
import { resolveWorkspaceAgentDirectories } from '../../config/workspace-context.js';

export interface AgentBootstrapResult {
  agentLoop: AgentLoop | null;
  subagentRegistry: SubagentRegistry | null;
  subagentSuggestions: Array<{ name: string; description: string }>;
  bootstrap: (
    apiKeys: Record<string, string>,
    conversation?: CoreMessage[],
    executionMode?: ExecutionMode
  ) => Promise<void>;
  isBootstrapping: boolean;
}

export function useAgentBootstrap(
  config: {
    cwd: string;
    maxTurns: number;
    systemPrompt: string;
    allowedTools?: string[];
    disallowedTools?: string[];
  },
  currentModel: string,
  executionMode: ExecutionMode,
  onEvent: (event: AgentEvent) => void,
  onApprovalRequired: (
    toolName: string,
    input: Record<string, unknown>,
    reason?: string
  ) => Promise<boolean>,
  onTimelineEvent: (event: AgentEvent) => void,
  resolvedApiKeys: Record<string, string>
): AgentBootstrapResult {
  const [agentLoop, setAgentLoop] = useState<AgentLoop | null>(null);
  const [subagentRegistry, setSubagentRegistry] = useState<SubagentRegistry | null>(null);
  const [subagentSuggestions, setSubagentSuggestions] = useState<
    Array<{ name: string; description: string }>
  >([]);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const currentModelRef = useRef(currentModel);
  const executionModeRef = useRef(executionMode);
  const onEventRef = useRef(onEvent);
  const onApprovalRequiredRef = useRef(onApprovalRequired);
  const onTimelineEventRef = useRef(onTimelineEvent);

  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);

  useEffect(() => {
    executionModeRef.current = executionMode;
  }, [executionMode]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onApprovalRequiredRef.current = onApprovalRequired;
  }, [onApprovalRequired]);

  useEffect(() => {
    onTimelineEventRef.current = onTimelineEvent;
  }, [onTimelineEvent]);

  // Auto-bootstrap when API keys become available.
  // This replaces the useEffect that was lost during App.tsx refactoring.
  const bootstrappedKeysRef = useRef<string>('');

  const bootstrap = useCallback(
    async (
      keys: Record<string, string>,
      conversationToHydrate?: CoreMessage[],
      executionModeOverride?: ExecutionMode
    ) => {
      const currentProvider = findProviderForModel(currentModelRef.current);

      // LM Studio is a local provider that does not require an API key
      const isLocalProvider = currentProvider === 'lmstudio';

      const hasAnyKey = Object.values(keys).some(
        (value) => typeof value === 'string' && value.trim().length > 0
      );

      if (!hasAnyKey && !isLocalProvider) {
        startTransition(() => {
          setAgentLoop(null);
          setSubagentRegistry(null);
          setSubagentSuggestions([]);
        });
        return;
      }

      const currentKey = currentProvider ? keys[currentProvider] : null;

      try {
        startTransition(() => {
          setIsBootstrapping(true);
        });
        const workspaceAgents = resolveWorkspaceAgentDirectories(config.cwd);
        const registry = new SubagentRegistry({
          projectDirs: workspaceAgents.project,
          globalDirs: workspaceAgents.global,
        });
        await registry.initialize();

        const suggestionItems = registry.getVisible().map((agent) => ({
          name: agent.name,
          description: agent.description,
        }));

        startTransition(() => {
          setSubagentRegistry(registry);
          setSubagentSuggestions(suggestionItems);
        });

        const selectedModel = currentModelRef.current?.trim();
        if (!selectedModel) {
          onTimelineEventRef.current({
            type: 'text',
            content: `Welcome to DynaTrader!

No model is configured yet. Here's how to get started:

1. Set an API key (choose one):
   export OPENAI_API_KEY=sk-...
   export ANTHROPIC_API_KEY=sk-ant-...
   export DEEPSEEK_API_KEY=sk-...

   Or use local models (no key needed):
   - Ollama: runs on localhost:11434
   - LM Studio: runs on localhost:1234

2. Select a model:
   /models          Browse all available models
   /model           Pick a model interactively

3. Start trading:
   /mode paper     Switch to paper trading (safe, no real money)
   /trade          Run an agent turn

Type /help for all commands.`,
          });
          setAgentLoop(null);
          return;
        }

        if ((!currentKey || currentKey.trim().length === 0) && !isLocalProvider) {
          const availableProviders = Object.keys(keys).filter(
            (p) => keys[p] && keys[p].trim().length > 0
          );
          const providerList = availableProviders.join(', ') || 'none';
          const modelProvider = currentProvider || 'unknown';
          onTimelineEventRef.current({
            type: 'text',
            content: `Model "${currentModelRef.current}" requires ${modelProvider} API key, but none is configured.\nAvailable providers with keys: ${providerList}\n\nFix: /connect ${modelProvider} or switch model via /models to one from ${availableProviders.length > 0 ? availableProviders[0] : 'a connected provider'}`,
          });
          setAgentLoop(null);
          return;
        }

        const loop = new AgentLoop(
          keys,
          {
            model: selectedModel,
            systemPrompt: config.systemPrompt,
            maxTokens: 4096,
            maxTurns: config.maxTurns,
            tools: [],
          },
          undefined,
          {
            onEvent: (event) => {
              onEventRef.current(event);
              onTimelineEventRef.current(event);
            },
            onApprovalRequired: onApprovalRequiredRef.current,
          },
        );

        await loop.configureToolPolicy(
          config.allowedTools,
          config.disallowedTools,
        );

        // The stdio runtime owns its own model router. Select this model there
        // before exposing the loop to the input handler, especially on first
        // bootstrap when there was no existing loop to switch.
        loop.switchModel(selectedModel);

        for (const message of conversationToHydrate ?? []) {
          loop.addMessage(message);
        }

        loop.setExecutionMode(executionModeOverride ?? executionModeRef.current);
        startTransition(() => {
          setAgentLoop(loop);
        });
      } catch (error) {
        const message = getErrorMessage(error);
        startTransition(() => {
          setAgentLoop(null);
          setSubagentRegistry(null);
          setSubagentSuggestions([]);
        });
        onTimelineEventRef.current({
          type: 'error',
          error: `Failed to initialize AI agent: ${message}`,
        });
      } finally {
        startTransition(() => {
          setIsBootstrapping(false);
        });
      }
    },
    [] // Empty deps - all accessed via refs
  );

  // Auto-bootstrap: call bootstrap when resolvedApiKeys change and
  // contain at least one non-empty key. Uses a ref to avoid re-bootstrapping
  // with the same keys on every render.
  useEffect(() => {
    const keysFingerprint = Object.entries(resolvedApiKeys)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('|');

    if (keysFingerprint === bootstrappedKeysRef.current) return;

    const hasAnyKey = Object.values(resolvedApiKeys).some(
      (value) => typeof value === 'string' && value.trim().length > 0
    );
    if (!hasAnyKey) return;

    bootstrappedKeysRef.current = keysFingerprint;
    void bootstrap(resolvedApiKeys);
  }, [resolvedApiKeys, bootstrap]);

  return { agentLoop, subagentRegistry, subagentSuggestions, bootstrap, isBootstrapping };
}
