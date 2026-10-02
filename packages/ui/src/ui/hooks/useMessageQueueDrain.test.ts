import React, { useState } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useMessageQueueDrain } from './useMessageQueueDrain.js';
import type { QueuedPrompt } from './useState/useUIState.js';

function createPrompt(id: string, text: string): QueuedPrompt {
  return { id, sessionId: 'session-a', text, status: 'queued' };
}

function QueueHarness(props: {
  initial: QueuedPrompt[];
  submitCommand: (text: string) => Promise<boolean>;
  onQueue: (queue: QueuedPrompt[]) => void;
}) {
  const [queue, setQueue] = useState(props.initial);
  props.onQueue(queue);
  useMessageQueueDrain({
    queuedMessages: queue,
    setQueuedMessages: setQueue,
    commandInFlightRef: { current: false },
    pendingQuestion: null,
    pendingConnectProvider: null,
    agentWizard: null,
    toolStateIsProcessing: false,
    pendingApprovalCount: 0,
    submitCommand: props.submitCommand,
  });
  return null;
}

describe('useMessageQueueDrain', () => {
  it('sends the FIFO prompt and removes it only after successful submission', async () => {
    let finishSubmission!: (success: boolean) => void;
    const submitCommand = vi.fn(() => new Promise<boolean>((resolve) => { finishSubmission = resolve; }));
    let latestQueue: QueuedPrompt[] = [];
    const onQueue = (queue: QueuedPrompt[]) => { latestQueue = queue; };
    let renderer!: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(React.createElement(QueueHarness, {
        initial: [createPrompt('one', 'first'), createPrompt('two', 'second')],
        submitCommand,
        onQueue,
      }));
    });
    expect(submitCommand).toHaveBeenCalledWith('first');
    expect(latestQueue[0]?.status).toBe('sending');

    await act(async () => { finishSubmission(true); await Promise.resolve(); });
    expect(latestQueue.map((prompt) => prompt.id)).toEqual(['two']);
    expect(submitCommand).toHaveBeenCalledTimes(2);
    expect(submitCommand).toHaveBeenLastCalledWith('second');
    renderer.unmount();
  });

  it('keeps a failed prompt visible and retryable', async () => {
    const submitCommand = vi.fn().mockResolvedValue(false);
    let latestQueue: QueuedPrompt[] = [];
    let renderer!: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(React.createElement(QueueHarness, {
        initial: [createPrompt('one', 'retry me')],
        submitCommand,
        onQueue: (queue) => { latestQueue = queue; },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestQueue).toHaveLength(1);
    expect(latestQueue[0]?.status).toBe('failed');
    expect(latestQueue[0]?.error).toBeTruthy();
    renderer.unmount();
  });
});
