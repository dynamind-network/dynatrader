/**
 * ConversationManager - Message buffer, context window, auto-compact.
 *
 * Manages conversation message history with automatic compaction when the
 * context window threshold is exceeded. Supports per-session conversation
 * instances for multi-session agents.
 *
 * When a StateDb instance is provided, messages are persisted to SQLite
 * and rehydrated on construction. Without a db, the manager is in-memory only.
 */

import type { ConversationMessage } from "@dyna/contracts";
import type { StateDb } from "../../state-db/state-db";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ConversationConfig {
  maxMessages: number;
  maxContextTokens: number;
  autoCompactThreshold: number;
  keepHeadMessages: number;
  keepRecentMessages: number;
  maxMessageChars: number;
}

const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  maxMessages: 200,
  maxContextTokens: 128000,
  autoCompactThreshold: 0.8,
  keepHeadMessages: 5,
  keepRecentMessages: 5,
  maxMessageChars: 2000,
};

// ---------------------------------------------------------------------------
// ConversationManager
// ---------------------------------------------------------------------------

export class ConversationManager {
  private messages: ConversationMessage[] = [];
  private config: ConversationConfig;
  private db: StateDb | null;
  private sessionId: string | null;

  constructor(config?: Partial<ConversationConfig>, db?: StateDb, sessionId?: string) {
    this.config = { ...DEFAULT_CONVERSATION_CONFIG, ...config };
    this.db = db ?? null;
    this.sessionId = sessionId ?? null;
    if (this.db && this.sessionId) this.loadFromDb();
  }

  private loadFromDb(): void {
    if (!this.db || !this.sessionId) return;
    const rows = this.db.getConversationMessages(this.sessionId);
    this.messages = rows.map((m) => ({
      role: m.role,
      content: extractTextContent(m.parts),
      timestamp: new Date(m.created_at),
    }));
  }

  private persistMessage(msg: ConversationMessage): void {
    if (!this.db || !this.sessionId) return;
    const id = `cmsg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.db.saveConversationMessage({
      id,
      session_id: this.sessionId,
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      parts: JSON.stringify([{ type: 'text', content: msg.content }]),
      token_count: 0,
      created_at: (msg.timestamp instanceof Date ? msg.timestamp : new Date()).getTime(),
    });
  }

  private persistTranscript(messages: ConversationMessage[]): void {
    if (!this.db || !this.sessionId) return;
    this.db.replaceConversationMessages(this.sessionId, messages.map((msg, index) => ({
      id: `cmsg-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      session_id: this.sessionId!,
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      parts: JSON.stringify([{ type: 'text', content: msg.content }]),
      token_count: 0,
      created_at: msg.timestamp.getTime(),
    })));
  }

  private commitTranscript(messages: ConversationMessage[]): void {
    this.persistTranscript(messages);
    this.messages = messages;
  }

  addMessage(msg: ConversationMessage): void {
    const content =
      typeof msg.content === "string" && msg.content.length > this.config.maxMessageChars
        ? `${msg.content.slice(0, 500)}\n... [truncated ${msg.content.length - 700} chars] ...\n${msg.content.slice(-200)}`
        : msg.content;
    const enriched = { ...msg, content };
    this.messages.push(enriched);
    this.persistMessage(enriched);
    if (this.messages.length > this.config.maxMessages) {
      this.messages.splice(0, this.messages.length - this.config.maxMessages);
    }
  }

  getMessages(): ConversationMessage[] { return [...this.messages]; }
  getMessageCount(): number { return this.messages.length; }

  updateContextWindowTokens(maxContextTokens: number): void {
    if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) return;
    this.config.maxContextTokens = Math.floor(maxContextTokens);
  }

  getContextWindowTokens(): number {
    return this.config.maxContextTokens;
  }

  estimateTokens(): number {
    let totalChars = 0;
    for (const msg of this.messages) totalChars += JSON.stringify(msg).length;
    return Math.ceil(totalChars / 4);
  }

  shouldCompact(): boolean {
    return this.estimateTokens() > this.config.maxContextTokens * this.config.autoCompactThreshold;
  }

  getMessagesForRequest(): ConversationMessage[] {
    if (this.shouldCompact()) this.compact();
    return this.getMessages();
  }

  compact(): string {
    const { keepHeadMessages, keepRecentMessages } = this.config;
    const isGeneratedSummary = (msg: ConversationMessage) =>
      msg.role === "system" && msg.content?.startsWith("[Conversation Summary]");
    let latestUserIndex = -1;
    const protectedIndexes = new Set<number>();
    this.messages.forEach((msg, index) => {
      if (msg.role === "system" && !isGeneratedSummary(msg)) protectedIndexes.add(index);
      if (msg.role === "user") latestUserIndex = index;
    });
    if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex);

    const keepHeadCount = Math.min(keepHeadMessages, this.messages.length);
    const keepTailStart = Math.max(keepHeadCount, this.messages.length - keepRecentMessages);
    const retainedIndexes = new Set(protectedIndexes);
    for (let index = 0; index < keepHeadCount; index++) {
      if (!isGeneratedSummary(this.messages[index])) retainedIndexes.add(index);
    }
    for (let index = keepTailStart; index < this.messages.length; index++) {
      if (!isGeneratedSummary(this.messages[index])) retainedIndexes.add(index);
    }
    if (retainedIndexes.size === this.messages.length) return "";

    const oldMessages = this.messages.filter((_msg, index) =>
      !retainedIndexes.has(index) && !isGeneratedSummary(this.messages[index]),
    );
    if (oldMessages.length === 0) {
      const retainedSummaries = this.messages.filter(isGeneratedSummary);
      if (retainedSummaries.length > 1) {
        let latestSummaryIndex = -1;
        for (let index = 0; index < this.messages.length; index++) {
          if (isGeneratedSummary(this.messages[index])) latestSummaryIndex = index;
        }
        const normalizedMessages = this.messages.filter((msg, index) => !isGeneratedSummary(msg) || index === latestSummaryIndex);
        this.commitTranscript(normalizedMessages);
      }
      return "";
    }
    const headMessages = this.messages.filter((_msg, index) => index < keepHeadCount && retainedIndexes.has(index));
    const recentMessages = this.messages.filter((_msg, index) => retainedIndexes.has(index) && index >= keepTailStart);
    const retainedOlder = this.messages.filter((_msg, index) => retainedIndexes.has(index) && index >= keepHeadCount && index < keepTailStart);

    let userCount = 0, assistantCount = 0, toolCount = 0;
    for (const msg of oldMessages) {
      if (msg.role === "user") userCount++;
      else if (msg.role === "assistant") assistantCount++;
      else if (msg.role === "tool") toolCount++;
    }

    const topics = extractTopics(oldMessages);
    const summary = `Compacted ${oldMessages.length} messages (${userCount} user, ${assistantCount} assistant, ${toolCount} tool). Topics: ${topics}. Head ${headMessages.length} messages and tail ${recentMessages.length} messages preserved.`;

    const summaryTimestamp = (() => {
      const prior = [...headMessages, ...retainedOlder].at(-1)?.timestamp.getTime() ?? 0;
      const next = recentMessages[0]?.timestamp.getTime();
      return next !== undefined && next > prior ? prior + (next - prior) / 2 : prior;
    })();
    const compactedMessages = [
      ...headMessages,
      ...retainedOlder,
      { role: "system" as const, content: `[Conversation Summary] ${summary}`, timestamp: new Date(summaryTimestamp) },
      ...recentMessages,
    ];
    this.commitTranscript(compactedMessages);
    return summary;
  }

  fork(): ConversationMessage[] { return this.getMessages(); }
  restore(messages: ConversationMessage[]): void { this.messages = [...messages]; }
  clear(): void { this.messages = []; }
}

function extractTextContent(parts: string): string {
  try {
    const parsed = JSON.parse(parts) as Array<{ type: string; content?: string }>;
    return parsed.map((p) => p.content ?? '').join('\n');
  } catch {
    return parts;
  }
}

function extractTopics(messages: ConversationMessage[]): string {
  const stopWords = new Set(["about", "their", "there", "which", "would", "could", "should"]);
  const topics = new Set<string>();
  for (const msg of messages) {
    if (!msg.content) continue;
    const words = msg.content.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 4 && !stopWords.has(word)) topics.add(word);
      if (topics.size >= 5) break;
    }
    if (topics.size >= 5) break;
  }
  return Array.from(topics).slice(0, 5).join(", ") || "general discussion";
}
