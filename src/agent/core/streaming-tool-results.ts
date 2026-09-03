/**
 * Streaming Tool Results
 *
 * Provides utilities for real-time tool progress streaming during chat.
 */

import type { ModelStreamChunk } from "@dyna/contracts";

export interface ToolProgressEvent {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  elapsedMs: number;
  message?: string;
}

/**
 * Creates a ModelStreamChunk for tool progress
 */
export function createToolProgressEvent(
  toolCallId: string,
  toolName: string,
  status: 'running' | 'completed' | 'error',
  elapsedMs: number,
  message?: string,
): ModelStreamChunk & { type: 'tool_progress' } {
  return {
    type: 'tool_progress',
    toolProgress: { toolCallId, toolName, status, elapsedMs, message },
  };
}

/**
 * Collects and stores tool progress events.
 * Useful for testing or when you want to buffer progress.
 */
export class CollectToolProgress {
  private events: ToolProgressEvent[] = [];

  record(event: ToolProgressEvent): void {
    this.events.push(event);
  }

  getEvents(): ToolProgressEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}