import type { ToolCall, ToolResult, ToolHandler, ToolDefinition, MemoryStore } from '@dyna/contracts';
import type { SessionManager, Session } from '@dyna/channels-core';
import type { CrossSessionRecall } from '@dyna/agent-core';

type SessionSearchMode = 'discover' | 'scroll';

interface SessionSearchEntry {
  id: string;
  sessionId: string;
  kind: string;
  timestamp: string;
  score: number;
  snippet: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export class SessionSearchTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'session_search',
    description: 'Search past sessions for matching turns or scroll around a matched message',
    category: 'session',
    inputSchema: {
      query: 'string?',
      sessionId: 'string?',
      aroundMessageId: 'string?',
      window: 'number?',
      limit: 'number?',
      mode: { type: 'string', enum: ['discover', 'scroll'], optional: true },
    },
    outputSchema: {
      mode: 'string',
      count: 'number',
      results: 'array',
    },
    permissionsRequired: ['session.search'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 10000,
    canRunInParallel: true,
    readOnly: true,
  };

  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly sessionManager?: SessionManager,
    private readonly crossSessionRecall?: CrossSessionRecall,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const mode = this.resolveMode(call.args.mode, call.args.sessionId, call.args.aroundMessageId);
      return mode === 'scroll'
        ? await this.scroll(call, start)
        : await this.discover(call, start);
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private async discover(call: ToolCall, start: number): Promise<ToolResult> {
    const query = this.normalizeString(call.args.query);
    const sessionId = this.normalizeString(call.args.sessionId);
    const limit = this.normalizeLimit(call.args.limit, 10, 1, 25);

    if (!query) {
      return {
        success: false,
        error: 'query must be a non-empty string for discovery mode',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const results = await this.memoryStore.search({
      scope: 'sessions',
      text: query,
      topK: Math.max(20, limit * 4),
    });

    const matches = results
      .map((result) => this.toSearchEntry(result))
      .filter((entry): entry is SessionSearchEntry => entry !== null)
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .slice(0, limit);

    // Enrich with distilled patterns from cross-session recall
    let recallPatterns: Array<{ sessionId: string; text: string; score: number }> = [];
    if (this.crossSessionRecall) {
      try {
        recallPatterns = await this.crossSessionRecall.search(query);
      } catch {
        // Graceful degradation — recall enrichment is best-effort
      }
    }

    const serialized = matches.map((entry) => this.serializeDiscoveryEntry(entry));

    if (recallPatterns.length > 0) {
      serialized.push({
        id: '__recall_patterns__',
        kind: 'cross_session_recall',
        results: recallPatterns.slice(0, 3).map((r) => ({
          sessionId: r.sessionId,
          text: r.text,
          score: r.score,
        })),
      });
    }

    return {
      success: true,
      data: {
        mode: 'discover' as const,
        query,
        sessionId: sessionId ?? null,
        count: matches.length,
        recallPatterns: recallPatterns.length,
        results: serialized,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async scroll(call: ToolCall, start: number): Promise<ToolResult> {
    const sessionId = this.normalizeString(call.args.sessionId);
    const aroundMessageId = this.normalizeString(call.args.aroundMessageId);
    const window = this.normalizeLimit(call.args.window, 5, 1, 25);

    if (!sessionId) {
      return {
        success: false,
        error: 'sessionId must be provided for scroll mode',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    if (!aroundMessageId) {
      return {
        success: false,
        error: 'aroundMessageId must be provided for scroll mode',
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const entries = await this.loadSessionEntries(sessionId);
    if (entries.length === 0) {
      return {
        success: false,
        error: `No session history found for ${sessionId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const matchIndex = entries.findIndex((entry) => entry.id === aroundMessageId || entry.messageId === aroundMessageId);
    if (matchIndex < 0) {
      return {
        success: false,
        error: `Message not found in session ${sessionId}: ${aroundMessageId}`,
        durationMs: Date.now() - start,
        truncated: false,
      };
    }

    const startIndex = Math.max(0, matchIndex - window);
    const endIndex = Math.min(entries.length, matchIndex + window + 1);
    const windowed = entries.slice(startIndex, endIndex);
    const session = this.serializeSession(this.sessionManager?.getSession(sessionId));

    return {
      success: true,
      data: {
        mode: 'scroll' as const,
        sessionId,
        aroundMessageId,
        window,
        count: windowed.length,
        beforeCount: matchIndex - startIndex,
        afterCount: endIndex - matchIndex - 1,
        results: windowed.map((entry) => this.serializeScrollEntry(entry)),
        bookendStart: windowed[0] ? this.serializeScrollEntry(windowed[0]) : null,
        bookendEnd: windowed[windowed.length - 1] ? this.serializeScrollEntry(windowed[windowed.length - 1]) : null,
        session,
      },
      durationMs: Date.now() - start,
      truncated: false,
    };
  }

  private async loadSessionEntries(sessionId: string): Promise<SessionSearchEntry[]> {
    const results = await this.memoryStore.search({
      scope: 'sessions',
      text: sessionId,
      topK: 1000,
    });

    return results
      .map((result) => this.toSearchEntry(result))
      .filter((entry): entry is SessionSearchEntry => entry !== null)
      .filter((entry) => entry.sessionId === sessionId)
      .sort((a, b) => {
        const left = Date.parse(a.timestamp);
        const right = Date.parse(b.timestamp);
        if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
          return left - right;
        }
        return a.id.localeCompare(b.id);
      });
  }

  private toSearchEntry(result: { id: string; score: number; payload: unknown; timestamp: Date }): SessionSearchEntry | null {
    if (!result.payload || typeof result.payload !== 'object') {
      return null;
    }

    const payload = result.payload as Record<string, unknown>;
    const sessionId = this.extractSessionId(payload);
    if (!sessionId) {
      return null;
    }

    const messageId = this.extractMessageId(result.id, payload);
    const text = this.extractText(payload);
    const timestamp = this.extractTimestamp(result.timestamp, payload);
    const kind = typeof payload.kind === 'string'
      ? payload.kind
      : this.inferKind(payload);

    return {
      id: result.id,
      sessionId,
      kind,
      timestamp,
      score: result.score,
      snippet: this.buildSnippet(text || this.describePayload(payload)),
      messageId,
      payload,
    };
  }

  private serializeDiscoveryEntry(entry: SessionSearchEntry): Record<string, unknown> {
    return {
      id: entry.id,
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      timestamp: entry.timestamp,
      score: entry.score,
      snippet: entry.snippet,
      session: this.serializeSession(this.sessionManager?.getSession(entry.sessionId)),
    };
  }

  private serializeScrollEntry(entry: SessionSearchEntry): Record<string, unknown> {
    return {
      id: entry.id,
      messageId: entry.messageId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      timestamp: entry.timestamp,
      score: entry.score,
      text: this.extractText(entry.payload) || entry.snippet,
      payload: entry.payload,
    };
  }

  private serializeSession(session: Session | undefined): Record<string, unknown> | null {
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      userId: session.userId,
      accountId: session.accountId,
      status: session.state?.blocked ? 'blocked' : session.state?.connected ? 'active' : 'inactive',
      connected: session.state?.connected ?? false,
      blocked: session.state?.blocked ?? false,
      blockReason: session.state?.blockReason ?? null,
      messageCount: session.state?.messageCount ?? 0,
      errorCount: session.state?.errorCount ?? 0,
      lastActivity: session.lastActivity.toISOString(),
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      riskLevel: session.metadata?.riskLevel ?? 'medium',
      deviceType: session.metadata?.deviceType ?? null,
      pairedChannel: session.pairing?.channelId ?? null,
      pairedAt: session.pairing?.pairedAt.toISOString() ?? null,
    };
  }

  private resolveMode(
    mode: unknown,
    sessionId: unknown,
    aroundMessageId: unknown,
  ): SessionSearchMode {
    if (mode === 'discover' || mode === 'scroll') {
      return mode;
    }

    if (this.isNonEmptyString(sessionId) && this.isNonEmptyString(aroundMessageId)) {
      return 'scroll';
    }

    return 'discover';
  }

  private extractSessionId(payload: Record<string, unknown>): string | null {
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      return payload.sessionId.trim();
    }

    if (typeof payload.id === 'string' && payload.state && payload.metadata) {
      return payload.id.trim();
    }

    if (payload.session && typeof payload.session === 'object') {
      const session = payload.session as Record<string, unknown>;
      if (typeof session.id === 'string' && session.id.trim()) {
        return session.id.trim();
      }
    }

    return null;
  }

  private extractMessageId(id: string, payload: Record<string, unknown>): string {
    if (typeof payload.messageId === 'string' && payload.messageId.trim()) {
      return payload.messageId.trim();
    }

    return id;
  }

  private extractTimestamp(timestamp: Date, payload: Record<string, unknown>): string {
    const fromPayload = this.normalizeString(payload.timestamp);
    if (fromPayload) {
      const parsed = new Date(fromPayload);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }

    return timestamp.toISOString();
  }

  private extractText(payload: Record<string, unknown>): string {
    const direct = this.normalizeString(payload.text);
    if (direct) return direct;

    const envelope = payload.envelope;
    if (envelope && typeof envelope === 'object') {
      const message = envelope as Record<string, unknown>;
      const text = this.normalizeString(message.text);
      if (text) return text;
      const content = this.normalizeString(message.content);
      if (content) return content;
    }

    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }

    if (typeof payload.error === 'object' && payload.error !== null) {
      const error = payload.error as Record<string, unknown>;
      const message = this.normalizeString(error.message);
      if (message) return `Error: ${message}`;
    }

    if (typeof payload.reason === 'string' && payload.reason.trim()) {
      return payload.reason.trim();
    }

    return '';
  }

  private describePayload(payload: Record<string, unknown>): string {
    const kind = typeof payload.kind === 'string' ? payload.kind : 'session_event';
    const session = this.extractSessionId(payload) ?? 'unknown-session';
    const text = this.extractText(payload);
    return text || `${kind} in ${session}`;
  }

  private inferKind(payload: Record<string, unknown>): string {
    if (payload.envelope && typeof payload.envelope === 'object') {
      return 'session_message';
    }
    if (typeof payload.reason === 'string') {
      return 'session_error';
    }
    if (payload.session && typeof payload.session === 'object') {
      return 'session_event';
    }
    return 'session_event';
  }

  private buildSnippet(text: string, maxLength = 180): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }

  private normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private normalizeLimit(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(min, Math.min(max, parsed));
  }
}
