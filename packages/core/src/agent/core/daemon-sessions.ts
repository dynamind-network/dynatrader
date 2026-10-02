/**
 * Daemon-Backed Sessions — Persistent Session State
 *
 * Sessions survive terminal disconnect. Reattach later via `attach()`.
 * Uses SQLite for persistence. Each session has a checkpoint that can
 * be restored on reattach.
 */

import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "@dyna/contracts";

export interface DaemonSession {
  id: string;
  name: string;
  status: "active" | "detached" | "archived";
  messages: ConversationMessage[];
  checkpoint: {
    turnCount: number;
    lastToolCall?: string;
    lastUserMessage?: string;
    tokenUsage: number;
    goalId?: string;
  };
  createdAt: number;
  updatedAt: number;
  detachedAt?: number;
}

export interface DaemonSessionConfig {
  /** Max sessions to keep in memory. Default: 50 */
  maxSessions?: number;
  /** Auto-archive detached sessions after this many ms. Default: 7 days */
  archiveAfterMs?: number;
  /** Checkpoint interval (ms). Default: 30000 */
  checkpointIntervalMs?: number;
}

export interface DaemonSessionEvents {
  onSessionCreated?: (session: DaemonSession) => void;
  onSessionDetached?: (session: DaemonSession) => void;
  onSessionReattached?: (session: DaemonSession) => void;
  onSessionArchived?: (session: DaemonSession) => void;
}

/**
 * Persistent session manager with detach/reattach support.
 */
export class DaemonSessionManager {
  private readonly maxSessions: number;
  private readonly archiveAfterMs: number;
  private readonly events: DaemonSessionEvents;

  private sessions = new Map<string, DaemonSession>();

  constructor(config?: DaemonSessionConfig, events?: DaemonSessionEvents) {
    this.maxSessions = config?.maxSessions ?? 50;
    this.archiveAfterMs = config?.archiveAfterMs ?? 7 * 24 * 60 * 60 * 1000;
    this.events = events ?? {};
  }

  /**
   * Create a new session.
   */
  createSession(name?: string): DaemonSession {
    const id = randomUUID();
    const now = Date.now();
    const session: DaemonSession = {
      id,
      name: name ?? `Session ${new Date(now).toLocaleString()}`,
      status: "active",
      messages: [],
      checkpoint: { turnCount: 0, tokenUsage: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    this.evictOldSessions();
    this.events.onSessionCreated?.(session);
    return session;
  }

  /**
   * Get an existing session or create one.
   */
  getOrCreateSession(sessionId: string, name?: string): DaemonSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session: DaemonSession = {
      id: sessionId,
      name: name ?? `Session ${new Date(Date.now()).toLocaleString()}`,
      status: "active",
      messages: [],
      checkpoint: { turnCount: 0, tokenUsage: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): DaemonSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions.
   */
  listSessions(): DaemonSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Detach a session (preserves state for reattach).
   */
  detach(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") return false;
    session.status = "detached";
    session.detachedAt = Date.now();
    session.updatedAt = Date.now();
    this.events.onSessionDetached?.(session);
    return true;
  }

  /**
   * Reattach to a detached session.
   */
  reattach(sessionId: string): DaemonSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "detached") return undefined;
    session.status = "active";
    session.detachedAt = undefined;
    session.updatedAt = Date.now();
    this.events.onSessionReattached?.(session);
    return session;
  }

  /**
   * Archive a session.
   */
  archive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = "archived";
    session.updatedAt = Date.now();
    this.events.onSessionArchived?.(session);
    return true;
  }

  /**
   * Update checkpoint for a session.
   */
  updateCheckpoint(
    sessionId: string,
    checkpoint: Partial<DaemonSession["checkpoint"]>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.checkpoint = { ...session.checkpoint, ...checkpoint };
    session.updatedAt = Date.now();
  }

  /**
   * Add a message to a session.
   */
  addMessage(sessionId: string, message: ConversationMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = Date.now();
  }

  /**
   * Get sessions for a specific goal.
   */
  getSessionsByGoal(goalId: string): DaemonSession[] {
    return this.listSessions().filter((s) => s.checkpoint.goalId === goalId);
  }

  /**
   * Auto-archive old detached sessions.
   */
  private evictOldSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === "detached" && session.detachedAt) {
        if (now - session.detachedAt > this.archiveAfterMs) {
          this.archive(id);
        }
      }
    }

    // Remove archived sessions if over limit
    const archived = this.listSessions().filter((s) => s.status === "archived");
    if (archived.length > this.maxSessions) {
      for (const session of archived.slice(this.maxSessions)) {
        this.sessions.delete(session.id);
      }
    }
  }

  /**
   * Export all sessions for persistence.
   */
  exportToStore(): DaemonSession[] {
    return this.listSessions();
  }

  /**
   * Load sessions from persistent store.
   */
  loadFromStore(records: DaemonSession[]): void {
    for (const record of records) {
      this.sessions.set(record.id, record);
    }
  }
}
