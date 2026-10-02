/**
 * Session Search (squish-memory style)
 *
 * A completely separate system from long-term memory recall.
 * Sessions are raw evidence from past agent runs; recall is distilled facts.
 *
 * Based on squish-memory's session store architecture:
 * - FTS5 search across session chunks (decisions, commands, files, errors)
 * - Cross-session recall via entity extraction
 * - Separate from the agent's long-term memory
 */

import type { MemoryStoreImpl } from "@dyna/memory-core";

export interface SessionChunk {
  id: string;
  sessionId: string;
  type: "summary" | "decision" | "command" | "file" | "error" | "todo";
  content: string;
  timestamp: Date;
  score?: number;
  why?: string;
}

export interface SessionGroup {
  sessionId: string;
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  chunkCount: number;
}

export interface SearchResult {
  chunks: SessionChunk[];
  totalResults: number;
  query: string;
}

/**
 * Session search provides cross-session recall.
 * Unlike the agent's memory (which stores distilled learnings),
 * session search stores raw evidence from past runs.
 */
export class SessionSearch {
  private readonly memory: MemoryStoreImpl;
  private readonly scope = "session_evidence";

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
  }

  /**
   * Index a session chunk (decision, command, file, error, etc.)
   */
  async indexChunk(chunk: Omit<SessionChunk, "id">): Promise<void> {
    await this.memory.put({
      scope: this.scope,
      kind: chunk.type,
      payload: {
        sessionId: chunk.sessionId,
        type: chunk.type,
        content: chunk.content,
        timestamp: chunk.timestamp.toISOString(),
      },
      ts: chunk.timestamp,
    });
  }

  /**
   * Index a full session summary
   */
  async indexSession(session: {
    sessionId: string;
    startedAt: Date;
    endedAt?: Date;
    summary?: string;
    chunks: Array<Omit<SessionChunk, "id">>;
  }): Promise<void> {
    // Index the summary
    if (session.summary) {
      await this.indexChunk({
        sessionId: session.sessionId,
        type: "summary",
        content: session.summary,
        timestamp: session.endedAt ?? new Date(),
      });
    }

    // Index all chunks
    for (const chunk of session.chunks) {
      await this.indexChunk(chunk);
    }
  }

  /**
   * Search across all sessions.
   * Returns chunks ranked by relevance.
   */
  async search(query: string, options?: {
    limit?: number;
    type?: SessionChunk["type"];
    sessionId?: string;
  }): Promise<SearchResult> {
    const limit = options?.limit ?? 10;

    const results = await this.memory.search({
      scope: this.scope,
      text: query,
      topK: limit * 2, // Over-fetch for filtering
    });

    let chunks: SessionChunk[] = results.map((r) => ({
      id: r.id,
      sessionId: (r.payload as Record<string, unknown>)?.sessionId as string ?? "",
      type: (r.payload as Record<string, unknown>)?.type as SessionChunk["type"] ?? "summary",
      content: (r.payload as Record<string, unknown>)?.content as string ?? "",
      timestamp: (r.payload as Record<string, unknown>)?.timestamp
        ? new Date((r.payload as Record<string, unknown>).timestamp as string)
        : r.timestamp,
      score: r.score,
      why: `Matched query: "${query}"`,
    }));

    // Filter by type
    if (options?.type) {
      chunks = chunks.filter((c) => c.type === options.type);
    }

    // Filter by session
    if (options?.sessionId) {
      chunks = chunks.filter((c) => c.sessionId === options.sessionId);
    }

    // Sort by score
    chunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return {
      chunks: chunks.slice(0, limit),
      totalResults: chunks.length,
      query,
    };
  }

  /**
   * Find related sessions based on shared entities or topics.
   */
  async findRelatedSessions(sessionId: string, limit = 5): Promise<SessionGroup[]> {
    // Get the session's chunks
    const sessionChunks = await this.memory.search({
      scope: this.scope,
      text: sessionId,
      topK: 100,
    });

    // Extract keywords from the session's content
    const keywords = new Set<string>();
    for (const chunk of sessionChunks) {
      const content = (chunk.payload as Record<string, unknown>)?.content as string ?? "";
      // Simple keyword extraction (in production, use NLP)
      const words = content.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      for (const word of words) {
        keywords.add(word);
      }
    }

    // Search for sessions with similar content
    const query = [...keywords].slice(0, 5).join(" ");
    const results = await this.memory.search({
      scope: this.scope,
      text: query,
      topK: limit * 10,
    });

    // Group by session
    const sessionMap = new Map<string, SessionGroup>();

    for (const result of results) {
      const resultSessionId = (result.payload as Record<string, unknown>)?.sessionId as string;
      if (resultSessionId === sessionId) continue; // Skip self

      if (!sessionMap.has(resultSessionId)) {
        sessionMap.set(resultSessionId, {
          sessionId: resultSessionId,
          startedAt: new Date(),
          chunkCount: 0,
        });
      }

      const group = sessionMap.get(resultSessionId)!;
      group.chunkCount++;
    }

    return [...sessionMap.values()]
      .sort((a, b) => b.chunkCount - a.chunkCount)
      .slice(0, limit);
  }

  /**
   * Get a session's full history.
   */
  async getSessionHistory(sessionId: string): Promise<SessionChunk[]> {
    const results = await this.memory.search({
      scope: this.scope,
      text: sessionId,
      topK: 100,
    });

    return results
      .filter(
        (r) =>
          (r.payload as Record<string, unknown>)?.sessionId === sessionId,
      )
      .map((r) => ({
        id: r.id,
        sessionId,
        type: (r.payload as Record<string, unknown>)?.type as SessionChunk["type"] ?? "summary",
        content: (r.payload as Record<string, unknown>)?.content as string ?? "",
        timestamp: (r.payload as Record<string, unknown>)?.timestamp
          ? new Date((r.payload as Record<string, unknown>).timestamp as string)
          : r.timestamp,
        score: r.score,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Extract chunks from a conversation transcript.
   * Returns structured chunks for indexing.
   */
  static extractChunks(
    sessionId: string,
    messages: Array<{ role: string; content: string; timestamp?: Date }>,
  ): Array<Omit<SessionChunk, "id">> {
    const chunks: Array<Omit<SessionChunk, "id">> = [];

    // First user message = summary
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) {
      chunks.push({
        sessionId,
        type: "summary",
        content: firstUser.content.slice(0, 500),
        timestamp: firstUser.timestamp ?? new Date(),
      });
    }

    // Extract decisions from assistant messages
    const decisionPatterns = [
      /decided to/i,
      /chose to/i,
      /let's/i,
      /we will/i,
      /the plan is/i,
      /approach:/i,
    ];

    // Extract commands from tool calls
    const commandPattern = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;

    // Extract file operations
    const filePattern = /(?:wrote|created|edited|modified|deleted)\s+(?:file\s+)?`?([^\s`]+\.[a-z]+)`?/gi;

    // Extract errors
    const errorPattern = /(?:error|failed|exception|crash)[:\s]+(.{20,200})/gi;

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      const content = msg.content;
      const timestamp = msg.timestamp ?? new Date();

      // Check for decisions
      for (const pattern of decisionPatterns) {
        if (pattern.test(content)) {
          chunks.push({
            sessionId,
            type: "decision",
            content: content.slice(0, 500),
            timestamp,
          });
          break;
        }
      }

      // Extract commands
      let cmdMatch;
      const cmdRegex = new RegExp(commandPattern.source, "g");
      while ((cmdMatch = cmdRegex.exec(content)) !== null) {
        chunks.push({
          sessionId,
          type: "command",
          content: cmdMatch[1]!.slice(0, 500),
          timestamp,
        });
      }

      // Extract file operations
      let fileMatch;
      const fileRegex = new RegExp(filePattern.source, "gi");
      while ((fileMatch = fileRegex.exec(content)) !== null) {
        chunks.push({
          sessionId,
          type: "file",
          content: fileMatch[0].slice(0, 500),
          timestamp,
        });
      }

      // Extract errors
      let errorMatch;
      const errorRegex = new RegExp(errorPattern.source, "gi");
      while ((errorMatch = errorRegex.exec(content)) !== null) {
        chunks.push({
          sessionId,
          type: "error",
          content: errorMatch[0].slice(0, 500),
          timestamp,
        });
      }
    }

    return chunks;
  }
}
