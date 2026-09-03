import type { CompressionResult, CompressionManifestEntry, CCRMarker } from '@dyna/contracts';
import { ContentType } from '@dyna/contracts';
import { get_encoding } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';
import { TokenCounter } from './token-counter';
import { ContentRouter } from './content-router';

export interface SmartCrusherConfig {
  maxTokens?: number;
  preserveIdFields?: boolean;
  logKeepHeadTail?: number;
  diffMaxLineLength?: number;
}

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_PRESERVE_ID_FIELDS = true;
const DEFAULT_LOG_KEEP_HEAD_TAIL = 10;
const DEFAULT_DIFF_MAX_LINE_LENGTH = 200;
const MAX_STRING_VALUE_LENGTH = 100;

const ID_FIELDS = new Set(['id', 'ID', 'uuid', 'UUID', '_id', 'name', 'type', 'status']);

export class SmartCrusher {
  private tokenCounter: TokenCounter;
  private contentRouter: ContentRouter;
  private config: Required<SmartCrusherConfig>;
  private encoding: Tiktoken | null = null;

  constructor(
    tokenCounter: TokenCounter,
    contentRouter: ContentRouter,
    config?: SmartCrusherConfig,
  ) {
    this.tokenCounter = tokenCounter;
    this.contentRouter = contentRouter;
    this.config = {
      maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
      preserveIdFields: config?.preserveIdFields ?? DEFAULT_PRESERVE_ID_FIELDS,
      logKeepHeadTail: config?.logKeepHeadTail ?? DEFAULT_LOG_KEEP_HEAD_TAIL,
      diffMaxLineLength: config?.diffMaxLineLength ?? DEFAULT_DIFF_MAX_LINE_LENGTH,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  compress(content: string, contentType: ContentType): CompressionResult {
    if (!content) {
      return {
        compressed: '',
        originalTokens: 0,
        compressedTokens: 0,
        ratio: 0,
        manifest: [],
        ccrs: [],
      };
    }

    switch (contentType) {
      case ContentType.JSON:
        return this.compressJson(content);
      case ContentType.DIFF:
        return this.compressDiff(content);
      case ContentType.LOG:
        return this.compressLog(content);
      default:
        return this.compressGeneric(content, contentType);
    }
  }

  compressMany(items: { content: string; contentType: ContentType }[]): CompressionResult[] {
    return items.map(item => this.compress(item.content, item.contentType));
  }

  shouldCrusherActivate(content: string, thresholdTokens?: number): boolean {
    const threshold = thresholdTokens ?? this.config.maxTokens;
    const tokenCount = this.tokenCounter.count(content);
    return tokenCount > threshold;
  }

  // ---------------------------------------------------------------------------
  // JSON mode
  // ---------------------------------------------------------------------------

  private compressJson(content: string): CompressionResult {
    const originalTokens = this.tokenCounter.count(content);
    const manifest: CompressionManifestEntry[] = [];

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.compressGeneric(content, ContentType.JSON);
    }

    // Non-object or array: pass through as-is
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const compressed = JSON.stringify(parsed);
      const compressedTokens = this.tokenCounter.count(compressed);
      return {
        compressed,
        originalTokens,
        compressedTokens,
        ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
        manifest: [],
        ccrs: [],
      };
    }

    // Process object keys
    const modified: Record<string, any> = {};
    const truncatedKeys: { key: string; originalLength: number; compressedLength: number }[] = [];

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > MAX_STRING_VALUE_LENGTH) {
        if (this.config.preserveIdFields && ID_FIELDS.has(key)) {
          modified[key] = value;
        } else {
          const truncated = value.substring(0, MAX_STRING_VALUE_LENGTH);
          modified[key] = truncated;
          truncatedKeys.push({
            key,
            originalLength: value.length,
            compressedLength: truncated.length,
          });
        }
      } else {
        modified[key] = value;
      }
    }

    const compressed = JSON.stringify(modified);
    const compressedTokens = this.tokenCounter.count(compressed);

    // Build manifest entries by finding key positions in original and compressed
    for (const { key, originalLength, compressedLength } of truncatedKeys) {
      const origOffset = this.findJsonValueOffset(content, key);
      const compOffset = this.findJsonValueOffset(compressed, key);

      if (origOffset !== null && compOffset !== null) {
        manifest.push({
          originalOffset: origOffset,
          compressedOffset: compOffset,
          originalLength,
          compressedLength,
          action: 'truncated',
          contentType: ContentType.JSON,
          reason: `Field "${key}" truncated from ${originalLength} to ${compressedLength} chars`,
        });
      }
    }

    return {
      compressed,
      originalTokens,
      compressedTokens,
      ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
      manifest,
      ccrs: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Diff mode
  // ---------------------------------------------------------------------------

  private compressDiff(content: string): CompressionResult {
    const originalTokens = this.tokenCounter.count(content);
    const lines = content.split('\n');
    const manifest: CompressionManifestEntry[] = [];
    const compressedLines: string[] = [];

    let origCumulativeOffset = 0;
    let compCumulativeOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLength = line.length;
      const isHeader = line.startsWith('---') || line.startsWith('+++');
      const isHunk = line.startsWith('@@');
      const isDiffLine = line.startsWith('+') || line.startsWith('-');

      if (isHeader || isHunk) {
        // Preserve header and hunk lines intact
        compressedLines.push(line);
        manifest.push({
          originalOffset: origCumulativeOffset,
          compressedOffset: compCumulativeOffset,
          originalLength: lineLength,
          compressedLength: lineLength,
          action: 'preserved',
          contentType: ContentType.DIFF,
          reason: isHeader ? 'diff header' : 'hunk header',
        });
        origCumulativeOffset += lineLength + 1; // +1 for newline
        compCumulativeOffset += lineLength + 1;
      } else if (isDiffLine && lineLength > this.config.diffMaxLineLength) {
        // Truncate long diff lines
        const truncated = line.substring(0, this.config.diffMaxLineLength) + '...';
        compressedLines.push(truncated);
        manifest.push({
          originalOffset: origCumulativeOffset,
          compressedOffset: compCumulativeOffset,
          originalLength: lineLength,
          compressedLength: truncated.length,
          action: 'truncated',
          contentType: ContentType.DIFF,
          reason: `Line exceeds max length (${lineLength} > ${this.config.diffMaxLineLength})`,
        });
        origCumulativeOffset += lineLength + 1;
        compCumulativeOffset += truncated.length + 1;
      } else {
        // Other lines preserved as-is
        compressedLines.push(line);
        manifest.push({
          originalOffset: origCumulativeOffset,
          compressedOffset: compCumulativeOffset,
          originalLength: lineLength,
          compressedLength: lineLength,
          action: 'preserved',
          contentType: ContentType.DIFF,
        });
        origCumulativeOffset += lineLength + 1;
        compCumulativeOffset += lineLength + 1;
      }
    }

    const compressed = compressedLines.join('\n');
    const compressedTokens = this.tokenCounter.count(compressed);

    return {
      compressed,
      originalTokens,
      compressedTokens,
      ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
      manifest,
      ccrs: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Log mode
  // ---------------------------------------------------------------------------

  private compressLog(content: string): CompressionResult {
    const originalTokens = this.tokenCounter.count(content);
    const lines = content.split('\n');
    const totalLines = lines.length;
    const headTail = this.config.logKeepHeadTail;
    const manifest: CompressionManifestEntry[] = [];

    // If total lines are within head+tail range, preserve all
    if (totalLines <= headTail * 2) {
      const compressed = content;
      const compressedTokens = this.tokenCounter.count(compressed);
      let cumulativeOffset = 0;
      for (const line of lines) {
        manifest.push({
          originalOffset: cumulativeOffset,
          compressedOffset: cumulativeOffset,
          originalLength: line.length,
          compressedLength: line.length,
          action: 'preserved',
          contentType: ContentType.LOG,
        });
        cumulativeOffset += line.length + 1;
      }
      return {
        compressed,
        originalTokens,
        compressedTokens,
        ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
        manifest,
        ccrs: [],
      };
    }

    // Lines to keep from head
    const headLines = lines.slice(0, headTail);
    // Lines to keep from tail
    const tailLines = lines.slice(totalLines - headTail);
    // Omitted middle lines
    const omittedCount = totalLines - headTail * 2;
    const omittedLines = lines.slice(headTail, totalLines - headTail);

    const summaryLine = `[... ${omittedCount} lines omitted ...]`;

    // Build compressed output: head + summary + tail
    const compressedLines = [...headLines, summaryLine, ...tailLines];
    const compressed = compressedLines.join('\n');

    // If compression doesn't reduce content size, return as-is
    if (compressed.length >= content.length) {
      const compressedTokens = this.tokenCounter.count(content);
      let cumulativeOffset = 0;
      for (const line of lines) {
        manifest.push({
          originalOffset: cumulativeOffset,
          compressedOffset: cumulativeOffset,
          originalLength: line.length,
          compressedLength: line.length,
          action: 'preserved',
          contentType: ContentType.LOG,
        });
        cumulativeOffset += line.length + 1;
      }
      return {
        compressed: content,
        originalTokens,
        compressedTokens,
        ratio: 1,
        manifest,
        ccrs: [],
      };
    }

    const compressedTokens = this.tokenCounter.count(compressed);

    // Build manifest
    let origCumulativeOffset = 0;
    let compCumulativeOffset = 0;

    // Head lines - preserved
    for (const line of headLines) {
      manifest.push({
        originalOffset: origCumulativeOffset,
        compressedOffset: compCumulativeOffset,
        originalLength: line.length,
        compressedLength: line.length,
        action: 'preserved',
        contentType: ContentType.LOG,
      });
      origCumulativeOffset += line.length + 1;
      compCumulativeOffset += line.length + 1;
    }

    // Summary line
    const omittedOriginalLength = omittedLines.reduce((sum, l) => sum + l.length + 1, 0) - 1; // -1 for last newline
    manifest.push({
      originalOffset: origCumulativeOffset,
      compressedOffset: compCumulativeOffset,
      originalLength: omittedOriginalLength,
      compressedLength: summaryLine.length,
      action: 'summarized',
      contentType: ContentType.LOG,
      reason: `${omittedCount} middle lines collapsed`,
    });
    origCumulativeOffset += omittedOriginalLength + 1; // +1 for the newline after the omitted block
    compCumulativeOffset += summaryLine.length + 1;

    // Tail lines - preserved
    for (const line of tailLines) {
      manifest.push({
        originalOffset: origCumulativeOffset,
        compressedOffset: compCumulativeOffset,
        originalLength: line.length,
        compressedLength: line.length,
        action: 'preserved',
        contentType: ContentType.LOG,
      });
      origCumulativeOffset += line.length + 1;
      compCumulativeOffset += line.length + 1;
    }

    return {
      compressed,
      originalTokens,
      compressedTokens,
      ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
      manifest,
      ccrs: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Generic mode (fallback for CODE, PLAINTEXT, ERROR, SEARCH_RESULT, UNKNOWN)
  // ---------------------------------------------------------------------------

  private compressGeneric(content: string, detectedType: ContentType): CompressionResult {
    const originalTokens = this.tokenCounter.count(content);
    const manifest: CompressionManifestEntry[] = [];

    if (originalTokens <= this.config.maxTokens) {
      // Under threshold - return as-is
      return {
        compressed: content,
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        manifest: [
          {
            originalOffset: 0,
            compressedOffset: 0,
            originalLength: content.length,
            compressedLength: content.length,
            action: 'preserved',
            contentType: detectedType,
            reason: 'Under token threshold, fully preserved',
          },
        ],
        ccrs: [],
      };
    }

    // Over threshold - truncate to maxTokens
    const truncated = this.truncateToMaxTokens(content, this.config.maxTokens);
    const compressedTokens = this.tokenCounter.count(truncated);

    manifest.push({
      originalOffset: 0,
      compressedOffset: 0,
      originalLength: content.length,
      compressedLength: truncated.length,
      action: 'truncated',
      contentType: detectedType,
      reason: `Truncated from ${originalTokens} to ${this.config.maxTokens} tokens`,
    });

    return {
      compressed: truncated,
      originalTokens,
      compressedTokens,
      ratio: originalTokens > 0 ? compressedTokens / originalTokens : 0,
      manifest,
      ccrs: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the character offset of a string value for a given key in a JSON string.
   * Returns the offset of the first character after the opening quote of the value,
   * or null if the key cannot be found.
   */
  private findJsonValueOffset(jsonStr: string, key: string): number | null {
    const pattern = `"${key}"`;
    const keyPos = jsonStr.indexOf(pattern);
    if (keyPos < 0) return null;

    const colonPos = jsonStr.indexOf(':', keyPos + pattern.length);
    if (colonPos < 0) return null;

    // Skip whitespace after colon
    let valueStart = colonPos + 1;
    while (valueStart < jsonStr.length && jsonStr[valueStart] === ' ') {
      valueStart++;
    }

    // Ensure it's a string value
    if (valueStart < jsonStr.length && jsonStr[valueStart] === '"') {
      return valueStart + 1; // offset after the opening quote
    }

    return null;
  }

  /**
   * Truncate text to fit within maxTokens using tiktoken encoding.
   */
  private truncateToMaxTokens(text: string, maxTokens: number): string {
    // If estimated character length is already under, check with exact tokens
    if (this.tokenCounter.estimate(text) <= maxTokens) {
      const actualTokens = this.tokenCounter.count(text);
      if (actualTokens <= maxTokens) {
        return text;
      }
    }

    // Use tiktoken directly for accurate encode-then-decode truncation
    let encoding = this.encoding;
    if (!encoding) {
      encoding = get_encoding('cl100k_base');
      this.encoding = encoding;
    }

    try {
      const tokens = encoding.encode(text);
      if (tokens.length <= maxTokens) {
        return text;
      }
      const truncatedTokens = tokens.slice(0, maxTokens);
      const decodedBytes = encoding.decode(new Uint32Array(truncatedTokens));
      return new TextDecoder().decode(decodedBytes);
    } catch {
      // Fallback: estimate-based character truncation
      const estimatedCharLength = Math.min(
        text.length,
        Math.ceil(maxTokens * 4),
      );
      return text.substring(0, estimatedCharLength);
    }
  }
}
