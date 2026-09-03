export function requireVisibleResponse(
  content: string | null | undefined,
  reasoningContent: string | null | undefined,
  context: string,
  showThinking = true,
): string {
  const visibleContent = normalizeVisibleText(content);
  if (visibleContent) {
    return visibleContent;
  }

  if (showThinking) {
    const visibleReasoning = normalizeVisibleText(reasoningContent);
    if (visibleReasoning) {
      return visibleReasoning;
    }
  }

  throw new Error(`${context} produced no visible output.`);
}

export function normalizeVisibleText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  if (/^(thinking process|reasoning|thought process|analysis)\s*:?\s*$/i.test(trimmed)) {
    return "";
  }

  return trimmed;
}
