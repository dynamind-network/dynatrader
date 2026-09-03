import { get_encoding, type TiktokenEncoding } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';

/**
 * Model-to-encoding mapping registry.
 */
const MODEL_ENCODINGS: Record<string, TiktokenEncoding> = {
  'gpt-4': 'cl100k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'text-davinci-003': 'p50k_base',
};

const DEFAULT_ENCODING: TiktokenEncoding = 'cl100k_base';

/**
 * TokenCounter provides token counting, tokenization, and estimation
 * using OpenAI's tiktoken library. It caches encoding instances and
 * token counts via an LRU cache.
 */
export class TokenCounter {
  private encodings: Map<string, Tiktoken> = new Map();
  private lruCache: Map<string, { tokens: number; timestamp: number }> = new Map();
  private maxCacheSize: number;

  /**
   * @param maxCacheSize Maximum number of entries in the LRU cache (default 1000).
   */
  constructor(maxCacheSize: number = 1000) {
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Resolve the tiktoken encoding for a given model name.
   * Caches the encoding instance so it is only loaded once per encoding type.
   */
  private resolveEncoding(model?: string): Tiktoken {
    const encodingName = model
      ? MODEL_ENCODINGS[model] ?? DEFAULT_ENCODING
      : DEFAULT_ENCODING;

    let encoding = this.encodings.get(encodingName);
    if (!encoding) {
      encoding = get_encoding(encodingName);
      this.encodings.set(encodingName, encoding);
    }
    return encoding;
  }

  /**
   * Tokenize a string into an array of token IDs.
   *
   * @param content  The text to tokenize.
   * @param model    Optional model name to select the encoding.
   * @returns        Array of token IDs.
   */
  tokenize(content: string, model?: string): number[] {
    if (!content) return [];
    const encoding = this.resolveEncoding(model);
    return Array.from(encoding.encode(content));
  }

  /**
   * Count the number of tokens in a string.
   * Results are cached in the LRU cache.
   *
   * @param content  The text to count.
   * @param model    Optional model name to select the encoding.
   * @returns        Token count.
   */
  count(content: string, model?: string): number {
    if (!content) return 0;

    const cacheKey = model ? `${model}:${content}` : `default:${content}`;

    // Check LRU cache
    const cached = this.lruCache.get(cacheKey);
    if (cached !== undefined) {
      return cached.tokens;
    }

    // Compute token count
    const encoding = this.resolveEncoding(model);
    const tokens = encoding.encode(content).length;

    // Evict oldest entry if cache is full
    if (this.lruCache.size >= this.maxCacheSize) {
      let oldestKey: string | null = null;
      let oldestTimestamp = Infinity;
      for (const [key, value] of this.lruCache.entries()) {
        if (value.timestamp < oldestTimestamp) {
          oldestTimestamp = value.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) {
        this.lruCache.delete(oldestKey);
      }
    }

    // Store in cache
    this.lruCache.set(cacheKey, { tokens, timestamp: Date.now() });
    return tokens;
  }

  /**
   * Estimate token count using a simple character-based heuristic (chars / 4).
   * This is a fast fallback when tiktoken is not needed.
   *
   * @param text  The text to estimate.
   * @returns     Estimated token count.
   */
  estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Count tokens across an array of messages (e.g., chat completion messages).
   * Each message adds 4 tokens for role overhead, and assistant messages
   * add an additional 3 tokens for the assistant prefix.
   *
   * @param messages  Array of message objects with `role` and `content`.
   * @param model     Optional model name to select the encoding.
   * @returns         Total token count across all messages.
   */
  countMessages(
    messages: { role: string; content: string }[],
    model?: string,
  ): number {
    let total = 0;
    for (const msg of messages) {
      total += this.count(msg.content, model);
      total += 4; // role overhead per message
      if (msg.role === 'assistant') {
        total += 3; // assistant prefix
      }
    }
    return total;
  }

  /**
   * Get a detailed breakdown of token usage per message.
   *
   * @param messages  Array of message objects with `role` and `content`.
   * @param model     Optional model name to select the encoding.
   * @returns         Array of per-message token breakdowns.
   */
  breakdown(
    messages: { role: string; content: string }[],
    model?: string,
  ): { role: string; tokens: number; content: string }[] {
    return messages.map((msg) => {
      let tokens = this.count(msg.content, model);
      tokens += 4; // role overhead
      if (msg.role === 'assistant') {
        tokens += 3; // assistant prefix
      }
      return { role: msg.role, tokens, content: msg.content };
    });
  }

  /**
   * Free all tiktoken encoding resources and clear the LRU cache.
   * After calling `close()`, the instance should no longer be used for
   * token counting without re-initialization.
   */
  close(): void {
    for (const encoding of this.encodings.values()) {
      encoding.free();
    }
    this.encodings.clear();
    this.lruCache.clear();
  }

  /**
   * Clear the LRU cache without freeing encoding resources.
   */
  clearCache(): void {
    this.lruCache.clear();
  }
}
