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

/**
 * Soft upper threshold: above this, dynamic compaction keeps injecting
 * strong compression nudges, so compression is much more likely.
 * Accepts: number or "X%" of model context window.
 * Default: "100%" (model's full context window).
 *
 * When usage exceeds this, the system becomes more aggressive about compressing.
 * When usage is below this, compression is less likely.
 */
export const DYNAMIC_COMPACT_MAX_CONTEXT_LIMIT = "100%";

/**
 * Soft lower threshold for reminder nudges: below this, turn/iteration
 * reminders are off (compression less likely). At/above this, reminders
 * are on. Accepts: number or "X%" of model context window.
 *
 * Default: "50%" — when context usage is above 50%, compression reminders
 * are active; below 50%, they're off.
 */
export const DYNAMIC_COMPACT_MIN_CONTEXT_LIMIT = "50%";

/**
 * How often the context-limit nudge fires (1 = every fetch, 5 = every 5th call)
 */
export const DYNAMIC_COMPACT_NUDGE_FREQUENCY = 5;

/**
 * Start adding compression reminders after this many
 * messages have happened since the last user message
 */
export const DYNAMIC_COMPACT_ITERATION_NUDGE_THRESHOLD = 15;

/**
 * Controls how likely compression is after user messages
 * ("strong" = more likely, "soft" = less likely)
 */
export const DYNAMIC_COMPACT_NUDGE_FORCE = "soft";

/**
 * Protected tool names from pruning during compression.
 * By default: task, skill, todowrite, todored (critical agent state).
 */
export const DYNAMIC_COMPACT_PROTECTED_TOOLS_DEFAULT: string[] = [
  "task",
  "skill",
  "todowrite",
  "todored",
];

/**
 * Protected file patterns from pruning via glob patterns.
 * Patterns match tool parameters.filePath (e.g. read/write/edit).
 */
export const DYNAMIC_COMPACT_PROTECTED_FILE_PATTERNS_DEFAULT: string[] = [];

/**
 * Importance + durability scoring weights.
 * - importance: 0.30 — how important the content is semantically
 * - task_relevance: 0.25 — how relevant to current task
 * - durability: 0.20 — how long the information should persist
 * - dependency: 0.15 — how much other content depends on this
 * - recency: 0.10 — how recent the content is
 */
export const IMPORTANCE_SCORING_WEIGHTS = {
  importance: 0.3,
  taskRelevance: 0.25,
  durability: 0.2,
  dependency: 0.15,
  recency: 0.1,
};

/**
 * Durability levels for compressed content.
 * - ephemeral: only relevant for current conversation turn
 * - session: relevant across conversation within this session
 * - long_term: should persist in memory across sessions
 * - permanent: core principles, never lose
 */
export type DurabilityLevel = "ephemeral" | "session" | "long_term" | "permanent";

/**
 * Importance score result for a message.
 */
export interface ImportanceScore {
  /** Overall score 0-1 (higher = more important/less compressible) */
  score: number;
  /** Durability level */
  durability: DurabilityLevel;
  /** Why this score was assigned */
  reasons: string[];
}

/**
 * Compression mode
 */
export type CompressionMode = "range" | "message";

/**
 * Compression result for a span of messages (range mode).
 */
export interface RangeCompressionResult {
  /** The summary text */
  summary: string;
  /** How many original messages were compressed */
  originalCount: number;
  /** Estimated token savings */
  tokensSaved: number;
  /** compression ratio (compressed/original) */
  compressionRatio: number;
  /** Messages that were protected and included in summary */
  protectedMessages: number;
}

/**
 * Compression result for a single message (message mode).
 */
export interface MessageCompressionResult {
  /** The compressed/summarized content */
  content: string;
  /** Whether the message was protected (kept verbatim) */
  protected: boolean;
  /** Importance score that determined compressibility */
  importance: ImportanceScore;
}

/**
 * Three outputs from auto compaction (like DCP's design).
 */
export interface AutoCompactionOutput {
  /** Context continuation — for immediate use in next model call */
  contextContinuation: Message[];
  /** Memory mutations — ADD/UPDATE/SUPERSEDE/DELETE for memory store */
  memoryMutations: MemoryMutation[];
  /** Session checkpoint — clean restart point for next conversation */
  sessionCheckpoint: CheckpointState;
}

/**
 * A mutation to apply to memory store.
 */
export interface MemoryMutation {
  /** Type of mutation */
  type: "ADD" | "UPDATE" | "SUPERSEDE" | "DELETE";
  /** Scope where mutation applies */
  scope: string;
  /** Kind of memory entry */
  kind: string;
  /** Payload content */
  payload: any;
  /** Importance/confidence of this mutation */
  importance: number;
  /** Whether this should supersede existing entries */
  supersedes?: string[];
}

/**
 * Session checkpoint state for next conversation.
 */
export interface CheckpointState {
  /** Current objective */
  objective: string;
  /** Current plan/next steps */
  currentPlan: string;
  /** Key decisions made */
  decisions: string[];
  /** Active preferences/constraints */
  preferences: string[];
  /** Unfinished/ongoing tasks */
  unfinishedTasks: string[];
  /** Important recent events */
  recentEvents: string[];
  /** Key entities referenced */
  entities: string[];
  /** Next action to take */
  nextAction: string;
  /** Do not forget items */
  doNotForget: string[];
}

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

  /**
   * Extract key insights from compacted conversation and write to MEMORY.md
   */
  async extractInsightsToMemory(memoryBridge: any, conversationMessages: Message[]): Promise<void> {
    const toSummarize = conversationMessages.filter((m) => !m.compacted);
    if (toSummarize.length < 2) return;

    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[Compaction] No API key available for insight extraction');
      return;
    }

    try {
      const { createProvider } = await import('./providers.js');
      const provider = createProvider('gemini', apiKey);

      const llmMessages = toSummarize.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: getMessageText(msg),
      }));

      const response = await provider.chat({
        model: 'gemini-1.5-flash',
        messages: llmMessages,
        systemPrompt: `You are extracting key insights from a trading agent conversation. 
Extract the most important:
1. Trading insights (risk management, market observations, strategy notes)
2. Decisions made and outcomes
3. Patterns or observations worth remembering
4. User constraints or preferences

Keep each insight concise (1 sentence max). Output as a JSON array of strings, e.g., ["insight 1", "insight 2"]. Do not include any other text.`,
        maxTokens: 2000,
        temperature: 0.3,
      });

      const insightsStr = response.content || '[]';
      const insights = JSON.parse(insightsStr) as string[];

      if (insights.length > 0) {
        // Write insights to MEMORY.md via memory bridge
        await memoryBridge.remember({
          content: insights.join('\n'),
          tags: ['extracted-insight', 'conversation-compaction'],
          importance: 0.6,
        });
        console.log(`[Compaction] Extracted ${insights.length} insights to MEMORY.md`);
      }
    } catch (error: any) {
      console.error('[Compaction] Insight extraction failed:', error.message);
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

// ============================================================================
// Two-Compaction System
// ============================================================================

/**
 * Score message importance for compaction decisions.
 * Higher scores = more important = less compressible.
 *
 * Scoring weights:
 * - importance: 0.30 — semantic importance
 * - task_relevance: 0.25 — relevance to current task
 * - durability: 0.20 — how long the info should persist
 * - dependency: 0.15 — how much other content depends on this
 * - recency: 0.10 — how recent the content is
 */
export function scoreMessageImportance(
  message: Message,
  index: number,
  totalMessages: number,
  currentTask: string = ''
): ImportanceScore {
  const reasons: string[] = [];
  let importance = 0.3;
  let taskRelevance = 0.1;
  let durability = 0.3;
  let dependency = 0.1;
  let recency = 0.1;

  const text = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);

  // Importance scoring
  if (message.role === 'system') {
    importance = 0.95;
    durability = 1.0;
    reasons.push('system message');
  }
  if (text.includes('[Session Summary]')) {
    importance = 0.8;
    durability = 0.9;
    reasons.push('session summary');
  }
  if (text.includes('[HEARTBEAT]') || text.includes('[HEARTBEAT晌]')) {
    importance = 0.4;
    durability = 0.2;
    reasons.push('heartbeat');
  }

  // Task relevance
  if (currentTask && text.toLowerCase().includes(currentTask.toLowerCase())) {
    taskRelevance = 0.9;
    reasons.push('mentions current task');
  }

  // Dependency scoring
  if (typeof message.content !== 'string') {
    const hasToolCalls = message.content.some((b: any) => b.type === 'tool_use');
    const hasToolResults = message.content.some((b: any) => b.type === 'tool_result');
    if (hasToolCalls || hasToolResults) {
      dependency = 0.8;
      reasons.push('has tool calls/results');
    }
  }

  // Recency scoring (linear decay)
  recency = Math.max(0.1, 1.0 - (index / totalMessages));

  // Durability scoring
  if (message.role === 'assistant' && text.length > 500) {
    durability = 0.7;
    reasons.push('substantial assistant message');
  }
  if (text.includes('```') || text.includes('function') || text.includes('class')) {
    durability = 0.8;
    reasons.push('code content');
  }

  // Weighted combination
  const score = (
    IMPORTANCE_SCORING_WEIGHTS.importance * importance +
    IMPORTANCE_SCORING_WEIGHTS.taskRelevance * taskRelevance +
    IMPORTANCE_SCORING_WEIGHTS.durability * durability +
    IMPORTANCE_SCORING_WEIGHTS.dependency * dependency +
    IMPORTANCE_SCORING_WEIGHTS.recency * recency
  );

  // Determine durability level
  let durabilityLevel: DurabilityLevel = 'ephemeral';
  if (durability >= 0.8) durabilityLevel = 'permanent';
  else if (durability >= 0.6) durabilityLevel = 'long_term';
  else if (durability >= 0.4) durabilityLevel = 'session';

  if (reasons.length === 0) reasons.push('default scoring');

  return {
    score: Math.min(1.0, Math.max(0.0, score)),
    durability: durabilityLevel,
    reasons,
  };
}

/**
 * Free pre-pass: prune old tool results without LLM call.
 * Saves 30%+ of context for free.
 *
 * Strategy:
 * - Keep tool results for recent messages (within tail budget)
 * - Replace old tool results with placeholder
 * - Preserve tool call structure (arguments)
 */
export function pruneToolOutputs(
  messages: Message[],
  options: {
    tailTokenBudget?: number;
    protectedTools?: string[];
    protectedPatterns?: string[];
  } = {}
): Message[] {
  const {
    tailTokenBudget = 20000,
    protectedTools = DYNAMIC_COMPACT_PROTECTED_TOOLS_DEFAULT,
    protectedPatterns = DYNAMIC_COMPACT_PROTECTED_FILE_PATTERNS_DEFAULT,
  } = options;

  // Calculate tail boundary
  let tailTokens = 0;
  let tailStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = typeof messages[i].content === 'string'
      ? messages[i].content
      : JSON.stringify(messages[i].content);
    const msgTokens = Math.ceil(text.length / 4);
    if (tailTokens + msgTokens > tailTokenBudget) {
      tailStart = i + 1;
      break;
    }
    tailTokens += msgTokens;
  }

  return messages.map((msg, idx) => {
    // Always keep tail messages intact
    if (idx >= tailStart) return msg;

    // Only process assistant messages with content blocks
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return msg;

    const newContent: ContentBlock[] = msg.content.map((block: any) => {
      // Keep tool_use blocks (calls) - they're small and important for structure
      if (block.type === 'tool_use') {
        // Check if tool is protected
        if (protectedTools.includes(block.name || '')) return block;

        // Truncate large arguments
        if (block.input && JSON.stringify(block.input).length > 1500) {
          return {
            ...block,
            input: { _truncated: true, originalSize: JSON.stringify(block.input).length },
          };
        }
        return block;
      }

      // Keep tool_result blocks that are protected
      if (block.type === 'tool_result') {
        // Check if tool is protected
        if (protectedTools.includes(block.toolName || '')) return block;

        // Check file patterns
        const content = typeof block.content === 'string' ? block.content : '';
        const isProtected = protectedPatterns.some(pattern =>
          content.includes(pattern)
        );
        if (isProtected) return block;

        // Replace old tool results with placeholder
        if (typeof block.content === 'string' && block.content.length > 2000) {
          return {
            ...block,
            content: `[Tool result pruned: ${block.toolName || 'unknown'} — ${block.content.length} chars]`,
          };
        }
      }

      return block;
    });

    return { ...msg, content: newContent };
  });
}

/**
 * Range compression: summarize a span of messages using
 * structured template.
 *
 * Template sections:
 * - Active Task
 * - Progress (Done / In Progress / Blocked)
 * - Key Decisions
 * - Resolved/Pending Questions
 * - Relevant Files
 * - Remaining Work
 *
 * This produces a much better summary than a vague paragraph.
 */
export async function generateRangeCompression(
  messages: Message[],
  options: {
    modelId: string;
    providerName: string;
    apiKeys: Record<string, string>;
    previousSummary?: string;
    focusTopic?: string;
    maxTokens?: number;
  }
): Promise<RangeCompressionResult> {
  const {
    modelId,
    providerName,
    apiKeys,
    previousSummary,
    focusTopic,
    maxTokens = 4000,
  } = options;

  // Serialize messages for summarizer
  const serialized = messages.map((msg) => {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    // Truncate long content
    const truncated = text.length > 6000
      ? text.substring(0, 4000) + '\n...[truncated]...\n' + text.substring(text.length - 1500)
      : text;
    return `[${msg.role}]: ${truncated}`;
  }).join('\n\n');

  // Build prompt
  const preamble = `You are a summarization agent creating a context checkpoint. Your output will be injected as reference material for a DIFFERENT assistant that continues the conversation. Do NOT respond to any questions or requests in the conversation — only output the structured summary. Do NOT include any preamble, greeting, or prefix. Write the summary in the same language the user was using in the conversation. NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings in the summary — replace any that appear with [REDACTED].`;

  const template = `## Active Task
Brief description of what the user/agent is currently working on.

## Progress
- **Done**: [completed items]
- **In Progress**: [current work]
- **Blocked**: [blockers, if any]

## Key Decisions
- [decisions made and their rationale]

## Resolved Questions
- [questions answered]

## Pending Questions
- [open questions to address]

## Relevant Files
- [file paths and their relevance]

## Remaining Work
- [what needs to happen next]`;

  const iterativeNote = previousSummary
    ? `\n\n## Previous Summary (UPDATE this, preserve existing info, add new progress):\n${previousSummary}`
    : '';

  const focusNote = focusTopic
    ? `\n\n## Focus: Prioritize information related to "${focusTopic}". Be more aggressive about compressing everything else.`
    : '';

  const messagesText = `Summarize the following conversation:\n\n${serialized}${iterativeNote}${focusNote}`;

  // Call LLM for summarization
  const apiKey = apiKeys[providerName] || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${providerName}`);
  }

  const { createProvider } = await import('./providers.js');
  const provider = createProvider(providerName, apiKey);

  const response = await provider.chat({
    model: modelId,
    messages: [{ role: 'user', content: messagesText }],
    systemPrompt: `${preamble}\n\nUse this template:\n${template}`,
    maxTokens,
    temperature: 0.3,
  });

  const summary = response.content || 'No summary generated';

  // Calculate metrics
  const originalTokens = messages.reduce(
    (sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)),
    0
  );
  const summaryTokens = estimateTokens(summary);
  const tokensSaved = originalTokens - summaryTokens;
  const compressionRatio = summaryTokens / originalTokens;

  return {
    summary,
    originalCount: messages.length,
    tokensSaved,
    compressionRatio,
    protectedMessages: 0,
  };
}

/**
 * Auto compaction: proactive compaction that produces three outputs.
 *
 * 1. Context continuation — for immediate use in next model call
 * 2. Memory mutations — ADD/UPDATE/SUPERSEDE/DELETE for memory store
 * 3. Session checkpoint — clean restart point for next conversation
 *
 * This is the "structured extraction pipeline" that produces durable state.
 */
export async function runAutoCompaction(
  messages: Message[],
  options: {
    modelId: string;
    providerName: string;
    apiKeys: Record<string, string>;
    memoryBridge?: any;
    previousSummary?: string;
    currentTask?: string;
  }
): Promise<AutoCompactionOutput> {
  const {
    modelId,
    providerName,
    apiKeys,
    memoryBridge,
    previousSummary,
    currentTask = '',
  } = options;

  // Step 1: Generate structured summary
  const compression = await generateRangeCompression(messages, {
    modelId,
    providerName,
    apiKeys,
    previousSummary,
    focusTopic: currentTask,
  });

  // Step 2: Extract memory mutations (Pass A/B/C from our design)
  const memoryMutations = await extractMemoryMutations(compression.summary, messages, {
    modelId,
    providerName,
    apiKeys,
  });

  // Step 3: Build session checkpoint
  const sessionCheckpoint = extractSessionCheckpoint(compression.summary, messages);

  // Step 4: Build context continuation
  const contextContinuation: Message[] = [
    {
      role: 'assistant',
      content: `[Session Summary]\n${compression.summary}\n\n[Continuing conversation...]`,
      compacted: true,
    },
  ];

  return {
    contextContinuation,
    memoryMutations,
    sessionCheckpoint,
  };
}

/**
 * Extract memory mutations from conversation summary.
 *
 * Pass A: Extract candidates (what should be remembered)
 * Pass B: Classify durability (ephemeral/session/long_term/permanent)
 * Pass C: Reconcile with existing memory (ADD/UPDATE/SUPERSEDE/DELETE)
 */
async function extractMemoryMutations(
  summary: string,
  messages: Message[],
  options: {
    modelId: string;
    providerName: string;
    apiKeys: Record<string, string>;
  }
): Promise<MemoryMutation[]> {
  const { modelId, providerName, apiKeys } = options;
  const apiKey = apiKeys[providerName] || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  try {
    const { createProvider } = await import('./providers.js');
    const provider = createProvider(providerName, apiKey);

    // Pass A: Extract candidates
    const extractionPrompt = `Extract key information from this conversation summary that should be persisted in memory. For each item, provide:
- content: what to remember
- kind: one of "preference", "constraint", "decision", "entity", "event", "insight"
- importance: 0.0-1.0
- durability: "ephemeral" | "session" | "long_term" | "permanent"

Output as a JSON array. Do not include any other text.

Summary:
${summary}`;

    const response = await provider.chat({
      model: modelId,
      messages: [{ role: 'user', content: extractionPrompt }],
      systemPrompt: 'You are a memory extraction agent. Extract actionable items from conversation summaries.',
      maxTokens: 2000,
      temperature: 0.3,
    });

    const candidates = JSON.parse(response.content || '[]') as Array<{
      content: string;
      kind: string;
      importance: number;
      durability: string;
    }>;

    // Pass B & C: Classify and reconcile (simplified for now)
    return candidates.map(candidate => ({
      type: 'ADD' as const,
      scope: 'conversation',
      kind: candidate.kind,
      payload: { content: candidate.content },
      importance: candidate.importance,
    }));
  } catch (error: any) {
    console.error('[AutoCompaction] Memory extraction failed:', error.message);
    return [];
  }
}

/**
 * Extract session checkpoint from conversation summary.
 * Builds a clean restart point for the next conversation.
 */
function extractSessionCheckpoint(
  summary: string,
  messages: Message[]
): CheckpointState {
  // Simple extraction from summary sections
  const lines = summary.split('\n');
  let currentSection = '';
  const sections: Record<string, string[]> = {
    objective: [],
    currentPlan: [],
    decisions: [],
    preferences: [],
    unfinishedTasks: [],
    recentEvents: [],
    entities: [],
    nextAction: [],
    doNotForget: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## Active Task')) currentSection = 'objective';
    else if (trimmed.startsWith('## Progress')) currentSection = 'currentPlan';
    else if (trimmed.startsWith('## Key Decisions')) currentSection = 'decisions';
    else if (trimmed.startsWith('## Resolved Questions')) currentSection = 'recentEvents';
    else if (trimmed.startsWith('## Pending Questions')) currentSection = 'unfinishedTasks';
    else if (trimmed.startsWith('## Relevant Files')) currentSection = 'entities';
    else if (trimmed.startsWith('## Remaining Work')) currentSection = 'nextAction';
    else if (currentSection && trimmed) {
      sections[currentSection]?.push(trimmed);
    }
  }

  return {
    objective: sections.objective.join('\n') || 'No objective extracted',
    currentPlan: sections.currentPlan.join('\n') || 'No plan extracted',
    decisions: sections.decisions.map(d => d.replace(/^[-*]\s*/, '')),
    preferences: sections.preferences.map(p => p.replace(/^[-*]\s*/, '')),
    unfinishedTasks: sections.unfinishedTasks.map(t => t.replace(/^[-*]\s*/, '')),
    recentEvents: sections.recentEvents.map(e => e.replace(/^[-*]\s*/, '')),
    entities: sections.entities.map(e => e.replace(/^[-*]\s*/, '')),
    nextAction: sections.nextAction.join('\n') || 'No next action extracted',
    doNotForget: sections.doNotForget.map(d => d.replace(/^[-*]\s*/, '')),
  };
}

/**
 * Multi-pass compression: continue compressing until token budget met
 * or progress stalls below threshold.
 *
 * From PR #97580: "Replace single-pass with multi-pass iterative
 * approach that continues compressing until token budget is met or
 * progress stalls below a configurable threshold."
 */
export async function runMultiPassCompression(
  messages: Message[],
  options: {
    modelId: string;
    providerName: string;
    apiKeys: Record<string, string>;
    targetTokens: number;
    maxPasses?: number;
    progressThreshold?: number;
    previousSummary?: string;
  }
): Promise<{
  summary: string;
  tokensSaved: number;
  passes: number;
  progressStalled: boolean;
}> {
  const {
    modelId,
    providerName,
    apiKeys,
    targetTokens,
    maxPasses = 5,
    progressThreshold = 0.05,
    previousSummary,
  } = options;

  let currentMessages = messages;
  let previousSummaryLocal = previousSummary;
  let totalTokensSaved = 0;
  let pass = 0;
  let progressStalled = false;

  while (pass < maxPasses) {
    const currentTokens = currentMessages.reduce(
      (sum, msg) => sum + estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)),
      0
    );

    if (currentTokens <= targetTokens) break;

    const compression = await generateRangeCompression(currentMessages, {
      modelId,
      providerName,
      apiKeys,
      previousSummary: previousSummaryLocal,
    });

    const tokensSavedThisPass = compression.tokensSaved;
    const progressRatio = tokensSavedThisPass / currentTokens;

    totalTokensSaved += tokensSavedThisPass;
    previousSummaryLocal = compression.summary;

    // Check if progress stalled
    if (progressRatio < progressThreshold) {
      progressStalled = true;
      break;
    }

    // Rebuild messages for next pass
    const summaryMessage: Message = {
      role: 'assistant',
      content: `[Session Summary]\n${compression.summary}\n\n[Continuing conversation...]`,
      compacted: true,
    };
    const keepMessages = currentMessages.slice(-5);
    currentMessages = [summaryMessage, ...keepMessages];

    pass++;
  }

  return {
    summary: previousSummaryLocal || '',
    tokensSaved: totalTokensSaved,
    passes: pass,
    progressStalled,
  };
}

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

