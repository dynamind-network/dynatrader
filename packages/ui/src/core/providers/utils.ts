import type { ToolCall } from './types.js';

export function appendWithOverlap(existing: string, incoming: string): string {
  if (!incoming) {
    return existing;
  }

  if (!existing) {
    return incoming;
  }

  const maxOverlap = Math.min(existing.length, incoming.length, 120);

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}

export function appendUniqueToolCall(toolCalls: ToolCall[], candidate: ToolCall): void {
  const exists = toolCalls.some(
    (toolCall) =>
      toolCall.id === candidate.id &&
      toolCall.name === candidate.name &&
      JSON.stringify(toolCall.arguments) === JSON.stringify(candidate.arguments)
  );

  if (!exists) {
    toolCalls.push(candidate);
  }
}

