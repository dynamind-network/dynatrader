/**
 * Normalize duplicated tokens in text output.
 * Handles repeated numeric patterns like "$1,234$1,234$1,234" -> "$1,234"
 */
export function normalizeDuplicatedTokens(text: string): string {
  return text.replace(/(\$?\d[\d,]*(?:\.\d+)?(?:[%a-zA-Z]+)?)+/g, (segment) => {
    const duplicateMatch = segment.match(/^(\$?\d[\d,]*(?:\.\d+)?(?:[%a-zA-Z]+)?)(?:\1)+$/);
    return duplicateMatch ? duplicateMatch[1] : segment;
  });
}

/**
 * Normalize repeated text segments.
 * Uses word boundaries to remove consecutive duplicate whole-word phrases.
 * Only triggers on longer phrases (8+ chars) to avoid false positives with short words.
 */
export function normalizeRepeatedSegments(text: string): string {
  let normalized = text;
  const repeatedSegmentPattern = /\b([a-zA-Z]{8,40})\s+\1\b/gi;

  let previous = '';
  let iterations = 0;
  const maxIterations = 10;

  while (normalized !== previous && iterations < maxIterations) {
    previous = normalized;
    normalized = normalized.replace(repeatedSegmentPattern, (_match, segment: string) => segment);
    iterations++;
  }

  return normalized;
}

/**
 * Normalize bullet continuations by inserting newlines before bullet/numbered list items.
 */
export function normalizeBulletContinuations(text: string): string {
  return text
    .replace(/([^\n])\s+(?=(?:\u2022|\*)\s)/g, '$1\n')
    .replace(/([^\n])\s+(?=(?:\d+\.)\s)/g, '$1\n');
}

/**
 * Split text into prose and code block segments.
 * Returns an array of { type, content } where type is 'prose' or 'code'.
 * Code blocks (fenced with ```) are preserved exactly as-is.
 */
function splitByCodeBlocks(text: string): Array<{ type: 'prose' | 'code'; content: string }> {
  const segments: Array<{ type: 'prose' | 'code'; content: string }> = [];
  const lines = text.split('\n');
  let inCode = false;
  let buffer: string[] = [];

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      // Flush prose buffer
      if (buffer.length > 0) {
        segments.push({ type: 'prose', content: buffer.join('\n') });
        buffer = [];
      }
      inCode = true;
      buffer.push(line);
    } else if (inCode && line.startsWith('```')) {
      buffer.push(line);
      segments.push({ type: 'code', content: buffer.join('\n') });
      buffer = [];
      inCode = false;
    } else {
      buffer.push(line);
    }
  }

  // Flush remaining (unclosed code block treated as prose to avoid data loss)
  if (buffer.length > 0) {
    segments.push({ type: inCode ? 'prose' : 'prose', content: buffer.join('\n') });
  }

  return segments;
}

/**
 * Apply all text normalization passes in sequence.
 * CRITICAL: Code blocks (fenced with ```) are preserved exactly as-is
 * to prevent corruption of generated code. Only prose sections are normalized.
 */
export function normalizeAssistantText(text: string): string {
  const segments = splitByCodeBlocks(text);
  const normalized = segments.map((segment) => {
    if (segment.type === 'code') {
      return segment.content; // Preserve code blocks exactly
    }
    const withDedupedTokens = normalizeDuplicatedTokens(segment.content);
    const withDedupedSegments = normalizeRepeatedSegments(withDedupedTokens);
    return normalizeBulletContinuations(withDedupedSegments);
  });
  return normalized.join('\n');
}
