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
    let latestUserIndex = -1;
    const protectedIndexes = new Set<number>();
    this.messages.forEach((msg, index) => {
      if (msg.role === "system") protectedIndexes.add(index);
      if (msg.role === "user") latestUserIndex = index;
    });
    if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex);

    const keepHeadCount = Math.min(keepHeadMessages, this.messages.length);
    const keepTailStart = Math.max(keepHeadCount, this.messages.length - keepRecentMessages);
    const retainedIndexes = new Set(protectedIndexes);
    for (let index = 0; index < keepHeadCount; index++) retainedIndexes.add(index);
    for (let index = keepTailStart; index < this.messages.length; index++) retainedIndexes.add(index);
    if (retainedIndexes.size === this.messages.length) return "";

    const headMessages = this.messages.slice(0, keepHeadCount);
    const oldMessages = this.messages.filter((_msg, index) => !retainedIndexes.has(index));
    const recentMessages = this.messages.filter((_msg, index) => retainedIndexes.has(index) && index >= keepTailStart);
    const retainedOlder = this.messages.filter((_msg, index) => retainedIndexes.has(index) && index >= keepHeadCount && index < keepTailStart);

    let userCount = 0, assistantCount = 0, toolCount = 0;
    for (const msg of oldMessages) {
      if (msg.role === "user") userCount++;
      else if (msg.role === "assistant") assistantCount++;
      else if (msg.role === "tool") toolCount++;
    }

    const topics = extractTopics(oldMessages);
    const previousSummary = this.messages.find(
      (m) => m.role === "system" && m.content?.startsWith("[Conversation Summary]"),
    )?.content;
    const summary = `Compacted ${oldMessages.length} messages (${userCount} user, ${assistantCount} assistant, ${toolCount} tool). Topics: ${topics}. Head ${headMessages.length} messages and tail ${recentMessages.length} messages preserved.`;

    const summaryParts = [previousSummary, `[Conversation Summary] ${summary}`].filter(Boolean);
    this.messages = [
      ...headMessages,
      ...retainedOlder,
      { role: "system", content: summaryParts.join("\n\n"), timestamp: new Date() },
      ...recentMessages,
    ];
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
