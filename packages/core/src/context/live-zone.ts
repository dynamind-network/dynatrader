import type { LiveZoneConfig, CompressionResult } from '@dyna/contracts';
import { SmartCrusher } from './smart-crusher';
import { TokenCounter } from './token-counter';
import { CCR } from './ccr';
import { ContentRouter } from './content-router';

export interface LiveZoneStats {
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalSavingsTokens: number;
  compressionRatio: number;
  compressCount: number;
  lastCompressAt: Date | null;
}

/**
 * LiveZoneCompressor manages mid-turn context compression during an agent's
 * tool-calling loop. It identifies the "live zone" (the most recent assistant
 * message and subsequent tool calls/responses), compresses large tool outputs,
 * and protects earlier context (the "frozen prefix").
 */
export class LiveZoneCompressor {
  private stats: LiveZoneStats;
  private frozenPrefixLength: number = 0;
  private contentRouter: ContentRouter;

  constructor(
    private smartCrusher: SmartCrusher,
    private tokenCounter: TokenCounter,
    private ccr: CCR,
    private config: LiveZoneConfig,
  ) {
    this.stats = this.createInitialStats();
    this.contentRouter = new ContentRouter();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Identify the frozen prefix and live zone from a message array.
   *
   * The frozen prefix consists of all messages before the last assistant
   * message. The live zone starts at that last assistant message and
   * includes everything after it (tool calls, responses, etc.).
   */
  identifyZones(messages: { role: string; content: string }[]): {
    frozenPrefix: { role: string; content: string }[];
    frozenTokens: number;
    liveZone: { role: string; content: string }[];
    liveZoneTokens: number;
  } {
    if (!messages || messages.length === 0) {
      return {
        frozenPrefix: [],
        frozenTokens: 0,
        liveZone: [],
        liveZoneTokens: 0,
      };
    }

    // Find the index of the last assistant message
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    // If no assistant message found, everything is frozen prefix
    if (lastAssistantIndex === -1) {
      const frozenTokens = this.tokenCounter.countMessages(messages);
      return {
        frozenPrefix: [...messages],
        frozenTokens,
        liveZone: [],
        liveZoneTokens: 0,
      };
    }

    const frozenPrefix = messages.slice(0, lastAssistantIndex);
    const liveZone = messages.slice(lastAssistantIndex);

    const frozenTokens = this.tokenCounter.countMessages(frozenPrefix);
    const liveZoneTokens = this.tokenCounter.countMessages(liveZone);

    this.frozenPrefixLength = frozenTokens;

    return { frozenPrefix, frozenTokens, liveZone, liveZoneTokens };
  }

  /**
   * Compress the live zone portion of a message array.
   *
   * - Tool messages with content exceeding maxToolOutputTokens are compressed
   *   via SmartCrusher, with optional CCR replacement for extremely long strings.
   * - The frozen prefix is never modified.
   * - Returns the merged (frozen prefix + compressed live zone) message array
   *   along with compression metadata.
   */
  async compressLiveZone(messages: { role: string; content: string }[]): Promise<{
    compressed: { role: string; content: string }[];
    originalTokens: number;
    compressedTokens: number;
    compressionRatio: number;
    compressionResults: Map<number, CompressionResult>;
  }> {
    // Handle empty messages
    if (!messages || messages.length === 0) {
      return {
        compressed: [],
        originalTokens: 0,
        compressedTokens: 0,
        compressionRatio: 1,
        compressionResults: new Map(),
      };
    }

    const { frozenPrefix, liveZone } = this.identifyZones(messages);

    // If no live zone (no assistant message found), return untouched
    if (liveZone.length === 0) {
      const totalTokens = this.tokenCounter.countMessages(messages);
      return {
        compressed: [...messages],
        originalTokens: totalTokens,
        compressedTokens: totalTokens,
        compressionRatio: 1,
        compressionResults: new Map(),
      };
    }

    const compressionResults = new Map<number, CompressionResult>();
    const compressedLiveZone: { role: string; content: string }[] = [];
    let liveOriginalTokens = 0; // content-level tokens for live zone originals
    let liveCompressedTokens = 0; // content-level tokens for live zone compressed
    let didCompress = false;

    // Track the index in the original messages array for compression results
    const liveZoneStartIndex = messages.length - liveZone.length;

    for (let i = 0; i < liveZone.length; i++) {
      const msg = liveZone[i];
      const originalIndex = liveZoneStartIndex + i;
      const contentTokens = this.tokenCounter.count(msg.content);

      // Only compress tool role messages that exceed the threshold
      if (msg.role === 'tool' && contentTokens > this.config.maxToolOutputTokens) {
        // Detect content type and compress
        const route = this.contentRouter.classify(msg.content);
        const crushResult = this.smartCrusher.compress(msg.content, route.contentType);

        // Apply CCR for extremely long string values
        const ccrResult = await this.ccr.replaceLongStrings(crushResult.compressed);
        const finalContent = ccrResult.compressed;
        const finalTokens = this.tokenCounter.count(finalContent);

        // Build the CompressionResult for this message index
        compressionResults.set(originalIndex, {
          compressed: finalContent,
          originalTokens: crushResult.originalTokens,
          compressedTokens: finalTokens,
          ratio: crushResult.originalTokens > 0
            ? finalTokens / crushResult.originalTokens
            : 0,
          manifest: crushResult.manifest,
          ccrs: ccrResult.markers,
        });

        compressedLiveZone.push({ role: msg.role, content: finalContent });
        liveOriginalTokens += crushResult.originalTokens;
        liveCompressedTokens += finalTokens;
        didCompress = true;
      } else {
        // No compression needed — preserve as-is
        compressedLiveZone.push({ ...msg });
        liveOriginalTokens += contentTokens;
        liveCompressedTokens += contentTokens;
      }
    }

    // Merge frozen prefix (unchanged) with compressed live zone
    const compressed = [...frozenPrefix, ...compressedLiveZone];

    // Compute overall token counts using countMessages (includes message overhead)
    const originalTotal = this.tokenCounter.countMessages(messages);
    const compressedTotal = this.tokenCounter.countMessages(compressed);
    const compressionRatio = originalTotal > 0 ? compressedTotal / originalTotal : 1;

    // Update cumulative statistics (using content-level tokens for consistency)
    this.stats.totalOriginalTokens += liveOriginalTokens;
    this.stats.totalCompressedTokens += liveCompressedTokens;
    this.stats.totalSavingsTokens =
      this.stats.totalOriginalTokens - this.stats.totalCompressedTokens;
    this.stats.compressionRatio =
      this.stats.totalOriginalTokens > 0
        ? this.stats.totalCompressedTokens / this.stats.totalOriginalTokens
        : 1;

    if (didCompress) {
      this.stats.compressCount++;
      this.stats.lastCompressAt = new Date();
    }

    return {
      compressed,
      originalTokens: originalTotal,
      compressedTokens: compressedTotal,
      compressionRatio,
      compressionResults,
    };
  }

  /**
   * Return the current compression statistics.
   */
  getStats(): LiveZoneStats {
    return { ...this.stats };
  }

  /**
   * Reset all compression statistics to their initial values.
   */
  resetStats(): void {
    this.stats = this.createInitialStats();
  }

  /**
   * Update the LiveZoneConfig at runtime. Only provided fields are changed;
   * unspecified fields retain their current values.
   */
  updateConfig(config: Partial<LiveZoneConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private createInitialStats(): LiveZoneStats {
    return {
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSavingsTokens: 0,
      compressionRatio: 1,
      compressCount: 0,
      lastCompressAt: null,
    };
  }
}
