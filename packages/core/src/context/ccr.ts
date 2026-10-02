import type { CCRMarker } from '@dyna/contracts';

export interface CCRConfig {
  /** Strings shorter than this aren't replaced (default: 50) */
  minStringLength?: number;
  /** Hash algorithm (default: 'SHA-256'; BLAKE3 reserved for future) */
  hashAlgorithm?: 'SHA-256' | 'BLAKE3';
  /** Storage backend (default: 'memory'; sqlite reserved for future) */
  backend?: 'memory' | 'sqlite';
}

export interface CCRStats {
  storedItems: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  totalSavingsBytes: number;
}

const DEFAULT_CONFIG = {
  minStringLength: 50,
  hashAlgorithm: 'SHA-256' as const,
  backend: 'memory' as const,
};

const MARKER_PREFIX = '<<ccr:';
const MARKER_SUFFIX = '>>';
const HASH_LENGTH = 16; // first 16 hex chars of the full hash
const SKIPPED_HASH = '0000000000000000';

/**
 * CCR (Cache Control Replacement) provides reversible compression using
 * SHA-256 hash markers in `<<ccr:HASH>>` format (Headroom-compatible).
 *
 * Long strings are replaced with short markers, allowing the original
 * content to be stored in a dictionary and restored later.
 */
export class CCR {
  private config: Required<CCRConfig>;
  private storage: Map<string, string> = new Map();
  private markerMeta: Map<string, { originalLength: number; replacedLength: number; storedAt: Date }> = new Map();

  constructor(config?: CCRConfig) {
    this.config = {
      minStringLength: config?.minStringLength ?? DEFAULT_CONFIG.minStringLength,
      hashAlgorithm: config?.hashAlgorithm ?? DEFAULT_CONFIG.hashAlgorithm,
      backend: config?.backend ?? DEFAULT_CONFIG.backend,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Store a string value and return a `<<ccr:HASH>>` marker.
   *
   * If value length < minStringLength, returns a marker but does not
   * store the value (retrieve will return null for it).
   */
  async store(value: string): Promise<{ marker: string; markerLength: number }> {
    if (value.length < this.config.minStringLength) {
      const marker = `${MARKER_PREFIX}${SKIPPED_HASH}${MARKER_SUFFIX}`;
      return { marker, markerLength: marker.length };
    }

    const hash = await this.computeHash(value);
    const marker = `${MARKER_PREFIX}${hash}${MARKER_SUFFIX}`;

    if (!this.storage.has(hash)) {
      this.storage.set(hash, value);
      this.markerMeta.set(hash, {
        originalLength: value.length,
        replacedLength: marker.length,
        storedAt: new Date(),
      });
    }

    return { marker, markerLength: marker.length };
  }

  /**
   * Retrieve the original string from a marker.
   * Returns null if the marker is unknown or was a skipped short value.
   */
  retrieve(marker: string): string | null {
    const hash = this.parseMarker(marker);
    if (!hash) return null;
    return this.storage.get(hash) ?? null;
  }

  /**
   * Find all long strings in text and replace them with markers.
   *
   * - Quoted strings (content between `"..."`) are detected first.
   * - Long contiguous non-whitespace sequences are detected second.
   * - Overlapping matches are resolved by keeping the first match.
   *
   * Returns the compressed text and an array of CCRMarker entries.
   */
  async replaceLongStrings(text: string): Promise<{ compressed: string; markers: CCRMarker[] }> {
    if (!text) {
      return { compressed: '', markers: [] };
    }

    // Collect all candidate matches
    const matches: Array<{ start: number; end: number; content: string }> = [];

    // 1. Find quoted strings (handles escaped quotes within)
    const quotedRegex = /"((?:\\.|[^"\\])*?)"/g;
    let match: RegExpExecArray | null;
    while ((match = quotedRegex.exec(text)) !== null) {
      const content = match[0]; // include surrounding quotes
      if (content.length >= this.config.minStringLength) {
        matches.push({
          start: match.index,
          end: match.index + content.length,
          content,
        });
      }
    }

    // 2. Find long contiguous non-whitespace sequences (not inside quotes)
    const unquotedRegex = /([^\s"]{50,})/g;
    while ((match = unquotedRegex.exec(text)) !== null) {
      const content = match[1];
      if (content.length >= this.config.minStringLength) {
        matches.push({
          start: match.index,
          end: match.index + content.length,
          content,
        });
      }
    }

    // Sort by start position
    matches.sort((a, b) => a.start - b.start);

    // Remove overlapping matches (keep the earliest / first seen)
    const filtered: typeof matches = [];
    for (const m of matches) {
      if (filtered.length === 0 || m.start >= filtered[filtered.length - 1].end) {
        filtered.push(m);
      }
    }

    // Build compressed result and marker metadata
    const ccrs: CCRMarker[] = [];
    let result = '';
    let lastEnd = 0;

    for (const m of filtered) {
      // Append text between the last match and this one
      result += text.slice(lastEnd, m.start);

      // Store the matched content and get a marker
      const { marker, markerLength } = await this.store(m.content);
      const hash = this.parseMarker(marker);
      if (!hash) {
        // Fallback: keep original text if parsing fails
        result += m.content;
        lastEnd = m.end;
        continue;
      }

      ccrs.push({
        key: hash,
        originalLength: m.content.length,
        replacedLength: markerLength,
        storedAt: new Date(),
      });

      result += marker;
      lastEnd = m.end;
    }

    // Append remaining text after the last match
    result += text.slice(lastEnd);

    return { compressed: result, markers: ccrs };
  }

  /**
   * Restore all markers in text back to their original values.
   * Markers whose hash is not found in storage are left intact.
   */
  restoreMarkers(text: string): string {
    const markerPattern = /<<ccr:([a-f0-9]{16})>>/g;
    return text.replace(markerPattern, (_match, hash: string) => {
      return this.storage.get(hash) ?? _match;
    });
  }

  /**
   * Return current storage statistics.
   */
  getStats(): CCRStats {
    let totalOriginalBytes = 0;
    let totalCompressedBytes = 0;

    for (const meta of this.markerMeta.values()) {
      totalOriginalBytes += meta.originalLength;
      totalCompressedBytes += meta.replacedLength;
    }

    return {
      storedItems: this.storage.size,
      totalOriginalBytes,
      totalCompressedBytes,
      totalSavingsBytes: totalOriginalBytes - totalCompressedBytes,
    };
  }

  /**
   * Clear all stored values and statistics.
   */
  clear(): void {
    this.storage.clear();
    this.markerMeta.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute an SHA-256 hash of the input and return the first 16 hex characters.
   */
  private async computeHash(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, HASH_LENGTH);
  }

  /**
   * Parse a `<<ccr:HASH>>` marker and return the hex hash, or null if invalid.
   */
  private parseMarker(marker: string): string | null {
    const match = marker.match(/^<<ccr:([a-f0-9]{16})>>$/);
    return match ? match[1] : null;
  }
}
