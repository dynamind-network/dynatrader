import { useEffect } from 'react';
import type { Message } from '../types.js';
import {
  deriveSessionTitle,
  buildTitleTranscript,
  cleanGeneratedTitle,
} from '../utils/chatHelpers.js';

/**
 * Title generation hook.
 *
 * Generates a short session title using the configured LLM after the
 * first assistant response. Falls back to deriving the title from the
 * first user message.
 *
 * This hook does NOT own the session title state - it receives
 * setSessionTitle from the caller (typically useSessionManager) and
 * writes to it when a title is generated.
 */
interface TitleGenOpts {
  messages: Message[];
  currentModel: string;
  resolvedApiKeys: Record<string, string>;
  isSwitchingSession: boolean;
  toolStateIsProcessing: boolean;
  /** Current session title (read-only, used to skip re-generation). */
  sessionTitle: string;
  /** Write the generated title back to the session manager. */
  setSessionTitle: (title: string) => void;
  /** Mutable ref tracking the session title (to avoid stale closures). */
  sessionTitleRef: React.MutableRefObject<string>;
  /** Mutable ref tracking whether title generation is in flight. */
  titleGenerationInFlightRef: React.MutableRefObject<boolean>;
  /** Mutable ref tracking whether title generation has completed. */
  titleGenerationDoneRef: React.MutableRefObject<boolean>;
  /** Optional system prompt for title generation. If omitted, titles are derived locally. */
  titleAgentPrompt?: string;
  /** Resolve provider name from model string. */
  findProviderForModel: (model: string) => string | null;
  /** Create a provider instance for title generation. */

  createProvider: (providerName: string, apiKey: string) => any | Promise<any>;
}

export function useTitleGeneration(options: TitleGenOpts): void {
  const {
    messages,
    currentModel,
    resolvedApiKeys,
    isSwitchingSession,
    toolStateIsProcessing,
    sessionTitle,
    setSessionTitle,
    sessionTitleRef,
    titleGenerationInFlightRef,
    titleGenerationDoneRef,
    titleAgentPrompt,
    findProviderForModel,
    createProvider,
  } = options;

  // Sync sessionTitleRef with sessionTitle state
  useEffect(() => {
    sessionTitleRef.current = sessionTitle;
  }, [sessionTitle, sessionTitleRef]);

  // Automatic title generation effect
  useEffect(() => {
    // Skip if switching session, processing, or already done/in flight
    if (
      isSwitchingSession ||
      toolStateIsProcessing ||
      titleGenerationDoneRef.current ||
      titleGenerationInFlightRef.current
    ) {
      return;
    }

    // Filter messages to user and assistant roles
    const transcriptMessages = messages.filter(
      (message): message is Message & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant'
    );

    // Check for at least 2 transcript messages and last message is assistant
    if (
      transcriptMessages.length < 2 ||
      transcriptMessages[transcriptMessages.length - 1].role !== 'assistant'
    ) {
      return;
    }

    // Skip if the title was already set to something meaningful
    // (e.g. from a resumed session or previous LLM generation)
    const currentDerivedTitle = deriveSessionTitle(messages);
    const currentSavedTitle = sessionTitleRef.current.trim();
    if (
      currentSavedTitle &&
      currentSavedTitle !== 'New chat' &&
      currentSavedTitle !== currentDerivedTitle
    ) {
      return;
    }

    titleGenerationInFlightRef.current = true;

    void (async () => {
      try {
        const generatedTitle = await generateTitle(
          transcriptMessages,
          currentModel,
          resolvedApiKeys,
          findProviderForModel,
          createProvider,
          titleAgentPrompt
        );
        const nextTitle = generatedTitle || currentDerivedTitle;
        setSessionTitle(nextTitle);
        sessionTitleRef.current = nextTitle;
        titleGenerationDoneRef.current = true;
      } finally {
        titleGenerationInFlightRef.current = false;
      }
    })();
  }, [
    messages,
    isSwitchingSession,
    toolStateIsProcessing,
    currentModel,
    resolvedApiKeys,
    sessionTitle,
    setSessionTitle,
    sessionTitleRef,
    titleAgentPrompt,
    findProviderForModel,
    createProvider,
  ]);

  // No return value - this hook operates via side effects (setSessionTitle)
  // and writes to the provided refs.
}

// ---------------------------------------------------------------------------
// Internal: pure async title generation
// ---------------------------------------------------------------------------

async function generateTitle(
  chatMessages: Message[],
  currentModel: string,
  resolvedApiKeys: Record<string, string>,
  findProviderForModel: (model: string) => string | null,
  createProvider: (
    providerName: string,
    apiKey: string
  ) => any | Promise<any>,
  titleAgentPrompt?: string
): Promise<string> {
  const providerName = findProviderForModel(currentModel) || 'anthropic';
  const apiKey = resolvedApiKeys[providerName] || resolvedApiKeys.anthropic || '';

  if (!apiKey) {
    return deriveSessionTitle(chatMessages);
  }

  if (!titleAgentPrompt || titleAgentPrompt.trim().length === 0) {
    return deriveSessionTitle(chatMessages);
  }

  const transcript = buildTitleTranscript(chatMessages);
  if (transcript.trim().length === 0) {
    return deriveSessionTitle(chatMessages);
  }

  try {
    const provider = await createProvider(providerName, apiKey);
    const response = await provider.chat({
      model: currentModel,
      messages: [{ role: 'user', content: transcript }],
      systemPrompt: titleAgentPrompt.trim(),
      maxTokens: 24,
      temperature: 0.2,
    });

    const candidate = cleanGeneratedTitle(response.content);
    return candidate || deriveSessionTitle(chatMessages);
  } catch {
    return deriveSessionTitle(chatMessages);
  }
}

