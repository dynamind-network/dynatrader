/**
 * Session Manager - Manages conversation sessions with branching/forking support.
 *
 * Users can explore multiple conversation paths without losing context.
 * Each session tracks its own message history and metadata independently
 * from the ConversationManager used by AgentCore.
 *
 * When a StateDb instance is provided, sessions are persisted to SQLite
 * and its session list is rehydrated on construction. Transcripts load when a
 * session is first opened. Without a db, the manager is in-memory only.
 */

import type { ConversationMessage } from "@dyna/contracts";
import type { StateDb } from "../../state-db/state-db";
import type { IntentRoute } from "./intent-router";

export interface SessionMetadata {
  intent?: IntentRoute;
  toolCallCount: number;
  tokenUsage: number;
  persona?: string | null;
}

export interface Session {
  id: string;
  name: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  messages: ConversationMessage[];
  metadata: SessionMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionInfo {
  id: string;
  name: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  parentBranchId?: string;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private messageCounts: Map<string, number> = new Map();
  private loadedTranscripts = new Set<string>();
  private activeSessionId: string | null = null;
  private db: StateDb | null;

  constructor(db?: StateDb) {
    this.db = db ?? null;
    if (this.db) this.loadFromDb();
  }

  private loadFromDb(): void {
    if (!this.db) return;
    const rows = this.db.listConversationSessions();

    for (const row of rows) {
      const meta = safeParseJson<SessionMetadata>(row.metadata, {
        toolCallCount: 0,
        tokenUsage: 0,
      });
      this.sessions.set(row.id, {
        id: row.id,
        name: row.title,
        parentBranchId: row.parent_id ?? undefined,
        messages: [],
        metadata: meta,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      });
      this.messageCounts.set(row.id, row.message_count ?? 0);
    }
  }

  private loadTranscript(session: Session): void {
    if (!this.db || this.loadedTranscripts.has(session.id)) return;
    const rows = this.db.getConversationMessages(session.id);
    session.messages = rows.map((row) => ({
      role: row.role,
      content: extractTextContent(row.parts),
      timestamp: new Date(row.created_at),
    }));
    this.messageCounts.set(session.id, rows.length);
    this.loadedTranscripts.add(session.id);
  }

  private persistSession(session: Session): void {
    if (!this.db) return;
    this.db.saveConversationSession({
      id: session.id,
      parent_id: session.parentBranchId ?? null,
      title: session.name,
      slug: session.id,
      status: 'active',
      metadata: JSON.stringify(session.metadata),
      created_at: session.createdAt.getTime(),
      updated_at: session.updatedAt.getTime(),
    });
  }

  private persistMessage(sessionId: string, msg: ConversationMessage): void {
    if (!this.db) return;
    const id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.db.saveConversationMessage({
      id,
      session_id: sessionId,
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      parts: JSON.stringify([{ type: 'text', content: msg.content }]),
      token_count: 0,
      created_at: (msg.timestamp instanceof Date ? msg.timestamp : new Date()).getTime(),
    });
  }

  createSession(name?: string): Session {
    const id = this.generateId();
    return this.ensureSession(id, name);
  }

  ensureSession(sessionId: string, name?: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.activeSessionId = sessionId;
      this.loadTranscript(existing);
      return existing;
    }

    const now = new Date();
    const session: Session = {
      id: sessionId,
      name: name ?? `Session ${now.toLocaleString()}`,
      messages: [],
      metadata: { toolCallCount: 0, tokenUsage: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.loadedTranscripts.add(sessionId);
    this.messageCounts.set(sessionId, 0);
    this.activeSessionId = sessionId;
    this.persistSession(session);
    return session;
  }

  getSession(sessionId?: string): Session | undefined {
    const id = sessionId?.trim() || this.activeSessionId;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) this.loadTranscript(session);
    return session;
  }

  forkSession(sessionId: string, fromMessageId: string): Session {
    const source = this.getSession(sessionId);
    if (!source) {
      throw new Error(`Source session not found: ${sessionId}`);
    }

    let cutoffIndex = -1;
    const numericIndex = parseInt(fromMessageId, 10);

    if (!isNaN(numericIndex) && numericIndex >= 0 && numericIndex < source.messages.length) {
      cutoffIndex = numericIndex;
    } else {
      for (let i = 0; i < source.messages.length; i++) {
        const msg = source.messages[i] as any;
        if (msg.id === fromMessageId) {
          cutoffIndex = i;
          break;
        }
      }
    }

    if (cutoffIndex === -1) {
      throw new Error(`Message not found in session ${sessionId}: ${fromMessageId}`);
    }

    const copiedMessages: ConversationMessage[] = source.messages
      .slice(0, cutoffIndex + 1)
      .map((msg) => ({ ...msg }));

    const id = this.generateId();
    const now = new Date();
    const session: Session = {
      id,
      name: `Fork of ${source.name}`,
      parentBranchId: source.id,
      forkedFromMessageId: fromMessageId,
      messages: copiedMessages,
      metadata: { ...source.metadata },
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    this.loadedTranscripts.add(id);
    this.messageCounts.set(id, copiedMessages.length);
    this.activeSessionId = id;
    this.persistSession(session);
    for (const msg of copiedMessages) {
      this.persistMessage(id, msg);
    }
    return session;
  }

  switchSession(sessionId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.activeSessionId = sessionId;
    return session;
  }

  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      result.push({
        id: session.id,
        name: session.name,
        messageCount: this.messageCounts.get(session.id) ?? session.messages.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        parentBranchId: session.parentBranchId,
      });
    }
    return result;
  }

  getActiveSession(): Session | null {
    if (!this.activeSessionId) return null;
    const session = this.sessions.get(this.activeSessionId) ?? null;
    if (session) this.loadTranscript(session);
    return session;
  }

  addMessage(msg: ConversationMessage): void {
    const session = this.getActiveSession();
    if (!session) return;
    session.messages.push(msg);
    this.messageCounts.set(session.id, (this.messageCounts.get(session.id) ?? session.messages.length - 1) + 1);
    session.updatedAt = new Date();
    this.persistSession(session);
    this.persistMessage(session.id, msg);
  }

  addMessageToSession(sessionId: string, msg: ConversationMessage): void {
    const session = this.ensureSession(sessionId);
    session.messages.push(msg);
    this.messageCounts.set(sessionId, (this.messageCounts.get(sessionId) ?? session.messages.length - 1) + 1);
    session.updatedAt = new Date();
    this.persistSession(session);
    this.persistMessage(sessionId, msg);
  }

  replaceSessionMessages(sessionId: string, messages: ConversationMessage[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const replacements = messages.map((message) => ({ ...message }));
    const updatedAt = new Date();
    if (this.db) {
      const rows = replacements.map((message, index) => ({
        id: `msg-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
        session_id: sessionId,
        role: message.role as 'user' | 'assistant' | 'system' | 'tool',
        parts: JSON.stringify([{ type: 'text', content: message.content }]),
        token_count: 0,
        created_at: (message.timestamp instanceof Date ? message.timestamp : new Date()).getTime(),
      }));
      this.db.replaceConversationMessages(sessionId, rows);
      this.persistSession({ ...session, messages: replacements, updatedAt });
    }
    session.messages = replacements;
    this.messageCounts.set(sessionId, replacements.length);
    this.loadedTranscripts.add(sessionId);
    session.updatedAt = updatedAt;
  }

  getMessages(): ConversationMessage[] {
    const session = this.getActiveSession();
    if (!session) return [];
    return session.messages;
  }

  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    this.messageCounts.delete(sessionId);
    this.loadedTranscripts.delete(sessionId);
    if (deleted && this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    if (deleted && this.db) {
      this.db.deleteConversationSession(sessionId);
    }
    return deleted;
  }

  private generateId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

function extractTextContent(parts: string): string {
  try {
    const parsed = JSON.parse(parts) as Array<{ type: string; content?: string }>;
    return parsed.map((p) => p.content ?? '').join('\n');
  } catch {
    return parts;
  }
}

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
