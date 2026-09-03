/**
 * Memory Fabric v2.5 — Query Rewriter
 *
 * Phase A: Heuristic-gated query rewriter.
 * Short referential follow-ups ("and the balance?", "what about BTC?") get
 * expanded with context from the recent conversation so memory search returns
 * relevant results instead of noise.
 *
 * Phase B (ReflectionRunner): Sliding-window segmentation — DONE.
 * Phase C (ReflectionRunner): Typed NOTE extraction — DONE.
 */

export interface QueryRewriterConfig {
  /** Max words in a query to consider rewriting. Default: 6 */
  shortQueryThreshold?: number;
  /** Minimum context words to inject. Default: 2 */
  minContextWords?: number;
  /** Max history messages to scan for context. Default: 10 */
  contextWindowSize?: number;
}

export interface RewriteResult {
  rewritten: string;
  wasRewritten: boolean;
  contextSource: string;
}

export interface MessageHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * Expands short referential queries using recent conversation context.
 */
export class QueryRewriter {
  private readonly shortQueryThreshold: number;
  private readonly minContextWords: number;
  private readonly contextWindowSize: number;

  private recentMessages: MessageHistoryEntry[] = [];

  constructor(config?: QueryRewriterConfig) {
    this.shortQueryThreshold = config?.shortQueryThreshold ?? 6;
    this.minContextWords = config?.minContextWords ?? 2;
    this.contextWindowSize = config?.contextWindowSize ?? 10;
  }

  /**
   * Add a message to the context window.
   */
  addMessage(role: "user" | "assistant", content: string): void {
    this.recentMessages.push({ role, content });
    if (this.recentMessages.length > this.contextWindowSize * 2) {
      this.recentMessages = this.recentMessages.slice(-this.contextWindowSize * 2);
    }
  }

  /**
   * Rewrite a query if it's short and referential.
   * Returns the rewritten query with injected context.
   */
  rewrite(query: string): RewriteResult {
    const trimmed = query.trim();
    const wordCount = trimmed.split(/\s+/).length;

    // Only rewrite short queries
    if (wordCount > this.shortQueryThreshold) {
      return {
        rewritten: trimmed,
        wasRewritten: false,
        contextSource: "none",
      };
    }

    // Check if query is referential (references something from context)
    const isReferential = this.isReferential(trimmed);
    if (!isReferential) {
      return {
        rewritten: trimmed,
        wasRewritten: false,
        contextSource: "none",
      };
    }

    // Extract context from recent messages
    const context = this.extractContext(trimmed);
    if (!context) {
      return {
        rewritten: trimmed,
        wasRewritten: false,
        contextSource: "none",
      };
    }

    const rewritten = `${trimmed} (context: ${context})`;
    return {
      rewritten,
      wasRewritten: true,
      contextSource: context,
    };
  }

  /**
   * Reset context window.
   */
  reset(): void {
    this.recentMessages = [];
  }

  private isReferential(query: string): boolean {
    const lower = query.toLowerCase();

    // Referential patterns
    const referentialPatterns = [
      /^(and|what about|how about|what about the|and the)\b/i,
      /^(tell me more|more details|continue|go on)\b/i,
      /^(the (one|thing|tool|method|approach))\b/i,
      /^(that|this|it)\s/i,
      /^(balance|price|status|result|outcome)\??$/i,
      /^(winning|losing|trades|positions|portfolio)\??$/i,
      /^(yes|no|ok|sure|proceed|confirm|do it|go ahead)\??$/i,
    ];

    return referentialPatterns.some((p) => p.test(lower));
  }

  private extractContext(query: string): string | null {
    const lower = query.toLowerCase();

    // Find the most recent assistant message as context source
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const msg = this.recentMessages[i]!;
      if (msg.role === "assistant") {
        const assistantContent = msg.content;

        // Extract key nouns/topics from assistant's response
        const topics = this.extractTopics(assistantContent);
        if (topics.length >= this.minContextWords) {
          return topics.slice(0, 5).join(", ");
        }
      }
    }

    // Fallback: find the most recent user message for cross-reference
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const msg = this.recentMessages[i]!;
      if (msg.role === "user" && msg.content.toLowerCase() !== lower) {
        const topics = this.extractTopics(msg.content);
        if (topics.length >= this.minContextWords) {
          return topics.slice(0, 5).join(", ");
        }
      }
    }

    return null;
  }

  private extractTopics(text: string): string[] {
    // Simple topic extraction: find capitalized words, numbers, and domain terms
    const words = text.split(/\s+/);
    const topics: string[] = [];
    const seen = new Set<string>();

    const domainTerms = [
      "BTC", "ETH", "SOL", "DOGE", "ADA", "XRP", "DOT", "AVAX",
      "portfolio", "balance", "trade", "position", "pnl", "profit",
      "loss", "risk", "strategy", "market", "price", "order",
    ];

    for (const word of words) {
      const cleaned = word.replace(/[.,!?;:'"()]/g, "").trim();
      if (cleaned.length < 2) continue;

      const lower = cleaned.toLowerCase();
      if (seen.has(lower)) continue;

      // Keep if capitalized (likely a noun/symbol) or a domain term
      if (
        cleaned[0] === cleaned[0]!.toUpperCase() ||
        domainTerms.includes(lower)
      ) {
        seen.add(lower);
        topics.push(cleaned);
      }
    }

    return topics;
  }
}
