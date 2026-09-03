export interface PackedText {
  text: string;
  truncated: boolean;
  originalLength: number;
  omittedLength: number;
}

export function packText(text: string, maxLength: number, tailLength = Math.floor(maxLength / 3)): PackedText {
  const originalLength = text.length;
  if (originalLength <= maxLength) {
    return { text, truncated: false, originalLength, omittedLength: 0 };
  }

  const safeTailLength = Math.max(0, Math.min(tailLength, Math.floor(maxLength / 2)));
  const headLength = Math.max(0, maxLength - safeTailLength - 24);
  const head = text.slice(0, headLength);
  const tail = safeTailLength > 0 ? text.slice(-safeTailLength) : '';
  const omittedLength = originalLength - head.length - tail.length;

  return {
    text: tail
      ? `${head}\n... [truncated ${omittedLength} chars] ...\n${tail}`
      : `${head}\n... [truncated ${omittedLength} chars]`,
    truncated: true,
    originalLength,
    omittedLength,
  };
}

export function packPreview(value: unknown, maxLength = 512): string {
  if (typeof value === 'string') {
    return packText(value.replace(/\s+/g, ' ').trim(), maxLength).text || 'completed';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  try {
    return packText(JSON.stringify(value), maxLength).text;
  } catch {
    return '[unserializable]';
  }
}
