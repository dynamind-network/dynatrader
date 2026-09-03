import { LIMITS } from '../utils/constants.js';
import type { Message, ContentBlock } from './types.js';

const COMPACTION = LIMITS.COMPACTION;

/**
 * Buffer tokens reserved for model output (8192 max output + safety margin)
 */
export const AUTOCOMPACT_BUFFER_TOKENS = COMPACTION.AUTOCOMPACT_BUFFER;

/**
 * Tokens remaining when warning level triggers
 */
export const WARNING_THRESHOLD_TOKENS = COMPACTION.WARNING_THRESHOLD;

/**
 * Tokens remaining when error level triggers (same as warning for backwards compat)
 */
export const ERROR_THRESHOLD_TOKENS = COMPACTION.ERROR_THRESHOLD;

/**
 * Maximum consecutive compaction failures before circuit breaker trips
 */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = COMPACTION.MAX_CONSECUTIVE_FAILURES;

export const compactionCircuitBreaker = {
  failures: 0,

  recordFailure(): void {
    this.failures++;
  },

  recordSuccess(): void {
    this.failures = 0;
  },

  isOpen(): boolean {
    return this.failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  },

  reset(): void {
    this.failures = 0;
  },
};

export function resetCompactionCircuitBreaker(): void {
  compactionCircuitBreaker.reset();
}

export function getCompactionCircuitBreakerState(): number {
  return compactionCircuitBreaker.failures;
}

const PRUNE_MINIMUM = 20000;
const PRUNE_PROTECT = 40000;

function getMessageText(msg: Message): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  return text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getPrompt(): string {
  return `You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.`;
}

export interface BudgetProjection {
  currentTokens: number;
  contextWindow: number;
  usagePercent: number;
  estimatedTurnsRemaining: number;
  tokensUntilCompact: number;
  needsCompact: boolean;
}

export const Compaction = {
  PRUNE_MINIMUM,
  PRUNE_PROTECT,
  estimateTokens,

  getBudgetProjection(
    messages: Message[],
    contextWindow: number,
    maxOutput: number = 8192
  ): BudgetProjection {
    const currentTokens = messages.reduce(
      (sum, msg) => sum + estimateTokens(getMessageText(msg)),
      0
    );
    const usable = contextWindow - Math.min(maxOutput, 32000) - AUTOCOMPACT_BUFFER_TOKENS;
    const usagePercent = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;

    // Estimate tokens per user turn
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const avgTokensPerTurn = userTurns > 0 ? currentTokens / userTurns : 500;

    const tokensUntilCompact = Math.max(0, usable - currentTokens);
    const estimatedTurnsRemaining = avgTokensPerTurn > 0
      ? Math.floor(tokensUntilCompact / avgTokensPerTurn)
      : 0;

    return {
      currentTokens,
      contextWindow,
      usagePercent,
      estimatedTurnsRemaining,
      tokensUntilCompact,
      needsCompact: currentTokens > usable,
    };
  },

  isOverflow(messages: Message[], contextWindow: number, maxOutput: number = 8192): boolean {
    if (contextWindow === 0) return false;

    const totalTokens = messages.reduce((sum, msg) => {
      return sum + estimateTokens(getMessageText(msg));
    }, 0);

    const usable = contextWindow - Math.min(maxOutput, 32000) - AUTOCOMPACT_BUFFER_TOKENS;
    return totalTokens > usable;
  },

  getWarningLevel(messages: Message[], contextWindow: number): 'ok' | 'warning' | 'error' {
    const estimatedTokens = messages.reduce(
      (sum, msg) => sum + estimateTokens(getMessageText(msg)),
      0
    );
    const warningThreshold = contextWindow - WARNING_THRESHOLD_TOKENS;
    const errorThreshold = contextWindow - ERROR_THRESHOLD_TOKENS;

    if (estimatedTokens > errorThreshold) return 'error';
    if (estimatedTokens > warningThreshold) return 'warning';
    return 'ok';
  },

  microcompact(messages: Message[], keepLast: number = 6): Message[] {
    if (messages.length <= keepLast + 2) return messages;

    const systemMsg = messages.filter(
      (m) =>
        typeof m.content === 'string' &&
        (m.content.includes('system') || m.content.includes('DynaMind'))
    );
    const recent = messages.slice(-keepLast);
    return [...systemMsg.slice(-1), ...recent];
  },

  reactiveCompact(messages: Message[]): Message[] {
    return messages
      .map((msg) => {
        if (Array.isArray(msg.content)) {
          const filtered = msg.content.filter((block) => block.type !== 'thinking');
          return { ...msg, content: filtered };
        }
        return msg;
      })
      .filter((msg) => {
        if (msg.compacted) return false;
        if (typeof msg.content === 'string' && msg.content.includes('[Pruned')) return false;
        return true;
      });
  },

  prune(input: { messages: Message[]; config?: { compaction?: { prune?: boolean } } }): number {
    if (input.config?.compaction?.prune === false) {
      return 0;
    }

    let total = 0;
    const toPrune: number[] = [];
    let turns = 0;

    for (let i = input.messages.length - 1; i >= 0; i--) {
      const msg = input.messages[i];
      if (msg.role === 'user') turns++;
      if (turns < 2) continue;

      if (msg.compacted) break;

      if (msg.role === 'assistant') {
        const text = getMessageText(msg);
        const tokens = estimateTokens(text);
        total += tokens;

        if (total > PRUNE_PROTECT) {
          toPrune.push(i);
        }
      }
    }

    if (total > PRUNE_MINIMUM) {
      for (const idx of toPrune) {
        const msg = input.messages[idx];
        input.messages[idx] = {
          ...msg,
          content: '[Pruned: old message cleared]',
          compacted: true,
        };
      }
      console.log(`[Compaction] Pruned ${toPrune.length} messages`);
    }

    return total;
  },

  async summarize(input: {
    messages: Message[];
    modelId: string;
    apiKeys: Record<string, string>;
    providerName: string;
  }): Promise<{ summary: string; tokensSaved: number }> {
    const toSummarize = input.messages.filter((m) => !m.compacted);
    if (toSummarize.length < 2) {
      return { summary: '', tokensSaved: 0 };
    }

    const apiKey = input.apiKeys[input.providerName] || input.apiKeys.anthropic;
    if (!apiKey) {
      throw new Error(`No API key for provider: ${input.providerName}`);
    }

    try {
      const { createProvider } = await import('./providers.js');
      const provider = createProvider(input.providerName, apiKey);

      const llmMessages = toSummarize.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: getMessageText(msg),
      }));

      const response = await provider.chat({
        model: input.modelId,
        messages: llmMessages,
        systemPrompt: getPrompt(),
        maxTokens: 4000,
        temperature: 0.3,
      });

      const summary = response.content || 'No summary generated';

      const originalTokens = toSummarize.reduce(
        (sum, msg) => sum + estimateTokens(getMessageText(msg)),
        0
      );
      const summaryTokens = estimateTokens(summary);
      const tokensSaved = originalTokens - summaryTokens;

      return { summary, tokensSaved };
    } catch (error: any) {
      compactionCircuitBreaker.recordFailure();
      console.error('[Compaction] Summarization failed:', error.message);
      throw error;
    }
  },

  async compact(input: {
    messages: Message[];
    modelId: string;
    contextWindow: number;
    apiKeys: Record<string, string>;
    providerName: string;
    config?: { compaction?: { prune?: boolean } };
  }): Promise<{
    compactedMessages: Message[];
    summary: string;
    tokensSaved: number;
    prunedCount: number;
  }> {
    if (compactionCircuitBreaker.isOpen()) {
      console.warn('[Compaction] Circuit breaker: too many consecutive failures, skipping');
      return {
        compactedMessages: input.messages,
        summary: '',
        tokensSaved: 0,
        prunedCount: 0,
      };
    }

    try {
      const prunedTokens = this.prune({
        messages: input.messages,
        config: input.config,
      });

      const { summary, tokensSaved } = await this.summarize(input);

      if (!summary) {
        return {
          compactedMessages: input.messages,
          summary: '',
          tokensSaved: 0,
          prunedCount: prunedTokens,
        };
      }

      compactionCircuitBreaker.recordSuccess();

      const keepMessages = input.messages.slice(-5);
      const summaryMessage: Message = {
        role: 'assistant',
        content: `[Session Summary]\n${summary}\n\n[Continuing conversation...]`,
        compacted: true,
      };

      const compactedMessages = [summaryMessage, ...keepMessages];

      return {
        compactedMessages,
        summary,
        tokensSaved,
        prunedCount: prunedTokens,
      };
    } catch (error) {
      compactionCircuitBreaker.recordFailure();
      throw error;
    }
  },
};

/**
 * Tier 1: Snip - remove old tool result content, keep structure
 */
export function snipToolResults(messages: Message[], maxResultBytes: number = 8192): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        if (block.content.length > maxResultBytes) {
          return {
            ...block,
            content:
              block.content.substring(0, maxResultBytes) +
              '\n... [snipped, use read tool for full content]',
          };
        }
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}

/**
 * Tier 3: Context collapse - archive old messages, replace with summary
 */
export function collapseContext(messages: Message[], protectTokens: number = 40000): Message[] {
  const systemMsgs = messages.filter(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('system')
  );

  let keptTokens = 0;
  const kept: Message[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const msgTokens = Math.ceil(text.length / 4);

    if (keptTokens + msgTokens <= protectTokens) {
      kept.unshift(msg);
      keptTokens += msgTokens;
    } else if (msg.role === 'assistant') {
      kept.unshift({
        role: 'assistant',
        content: '[Earlier conversation content archived to save context]',
        compacted: true,
      });
      break;
    }
  }

  return [...systemMsgs.slice(-1), ...kept];
}
