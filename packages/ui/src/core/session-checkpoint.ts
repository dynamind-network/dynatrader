/**
 * Session Checkpoint — JSONL-based conversation serialization (Codex-style)
 *
 * Writes each turn as a JSONL entry for crash-safe, append-only persistence.
 * On resume, replays JSONL to rebuild conversation history with smart truncation.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DYNAMIND_DIR } from '../utils/constants.js';

export interface TurnEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  userMessage?: string;
  assistantResponse?: string;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    success: boolean;
    durationMs?: number;
  }>;
  planId?: string;
  goalId?: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  goalId?: string;
  planId?: string;
  currentStep?: string;
  pendingOperations?: string[];
  modifiedFiles?: string[];
  lastTurnAt: number;
  turnCount: number;
}

export interface CheckpointOptions {
  storageDir?: string;
  maxTranscriptLines?: number;
  smartTruncate?: boolean;
  keepFirstExchange?: boolean;
  keepLastN?: number;
}

const DEFAULT_OPTIONS: Required<CheckpointOptions> = {
  storageDir: DYNAMIND_DIR,
  maxTranscriptLines: 1000,
  smartTruncate: true,
  keepFirstExchange: true,
  keepLastN: 20,
};

export class SessionCheckpoint {
  private storageDir: string;
  private sessionId: string;
  private sessionDir: string;
  private transcriptPath: string;
  private statePath: string;
  private options: Required<CheckpointOptions>;
  private turnBuffer: TurnEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string, options?: CheckpointOptions) {
    this.sessionId = sessionId;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.storageDir = this.options.storageDir;
    this.sessionDir = path.join(this.storageDir, 'sessions', sessionId);
    this.transcriptPath = path.join(this.sessionDir, 'transcript.jsonl');
    this.statePath = path.join(this.sessionDir, 'state.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    this.flushInterval = setInterval(() => void this.flush(), 5000);
  }

  async appendTurn(entry: Omit<TurnEntry, 'id' | 'timestamp' | 'sessionId'>): Promise<TurnEntry> {
    const fullEntry: TurnEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      sessionId: this.sessionId,
      ...entry,
    };

    this.turnBuffer.push(fullEntry);

    if (this.turnBuffer.length >= 10) {
      await this.flush();
    }

    return fullEntry;
  }

  async flush(): Promise<void> {
    if (this.turnBuffer.length === 0) return;

    const lines = this.turnBuffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.turnBuffer = [];

    await fs.appendFile(this.transcriptPath, lines, 'utf-8');

    const stat = await fs.stat(this.transcriptPath).catch(() => null);
    if (stat && stat.size > 10 * 1024 * 1024) {
      await this.truncateTranscript();
    }
  }

  async saveState(state: Partial<SessionState>): Promise<void> {
    const current = await this.loadState().catch(() => null);
    const merged: SessionState = {
      sessionId: this.sessionId,
      lastTurnAt: Date.now(),
      turnCount: (current?.turnCount ?? 0) + 1,
      ...current,
      ...state,
    };

    await fs.writeFile(this.statePath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  async loadState(): Promise<SessionState | null> {
    try {
      const data = await fs.readFile(this.statePath, 'utf-8');
      return JSON.parse(data) as SessionState;
    } catch {
      return null;
    }
  }

  async loadTranscript(): Promise<TurnEntry[]> {
    try {
      const data = await fs.readFile(this.transcriptPath, 'utf-8');
      const lines = data.split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line) as TurnEntry);
    } catch {
      return [];
    }
  }

  async loadTranscriptSmart(): Promise<TurnEntry[]> {
    const all = await this.loadTranscript();

    if (!this.options.smartTruncate || all.length <= this.options.keepLastN * 2) {
      return all;
    }

    const result: TurnEntry[] = [];

    if (this.options.keepFirstExchange && all.length > 0) {
      const firstUserIdx = all.findIndex((e) => e.userMessage);
      if (firstUserIdx >= 0) {
        result.push(all[firstUserIdx]);
        const firstAssistantIdx = all.findIndex(
          (e, i) => i > firstUserIdx && e.assistantResponse
        );
        if (firstAssistantIdx >= 0) {
          result.push(all[firstAssistantIdx]);
        }
      }
    }

    const recentStart = Math.max(all.length - this.options.keepLastN, result.length);
    for (let i = recentStart; i < all.length; i++) {
      const entry = all[i];
      if (entry.toolCalls?.some((tc) => tc.name === 'write' || tc.name === 'edit')) {
        result.push(entry);
      } else if (i >= recentStart) {
        result.push(entry);
      }
    }

    const seen = new Set<string>();
    return result.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }

  async resume(): Promise<{
    conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
    state: SessionState | null;
    turnCount: number;
  }> {
    const transcript = await this.loadTranscriptSmart();
    const state = await this.loadState();

    const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const entry of transcript) {
      if (entry.userMessage) {
        conversation.push({ role: 'user', content: entry.userMessage });
      }
      if (entry.assistantResponse) {
        conversation.push({ role: 'assistant', content: entry.assistantResponse });
      }
    }

    return { conversation, state, turnCount: transcript.length };
  }

  async deleteSession(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await fs.rm(this.sessionDir, { recursive: true, force: true });
  }

  async listSessions(): Promise<string[]> {
    const sessionsDir = path.join(this.storageDir, 'sessions');
    try {
      const entries = await fs.readdir(sessionsDir);
      return entries.filter((e) => {
        const stat = require('fs').statSync(path.join(sessionsDir, e));
        return stat.isDirectory();
      });
    } catch {
      return [];
    }
  }

  private async truncateTranscript(): Promise<void> {
    const all = await this.loadTranscript();
    const truncated = all.slice(-this.options.maxTranscriptLines);
    const data = truncated.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(this.transcriptPath, data, 'utf-8');
  }
}

export default SessionCheckpoint;

