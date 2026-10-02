import { useEffect } from 'react';
import type { QueuedPrompt } from './useState/useUIState.js';

/**
 * Drains queued messages one at a time when the agent is idle.
 *
 * Waits until no command is in flight, no tool is processing,
 * no pending approvals/questions/wizards exist, then submits
 * the next queued message.
 */
export function useMessageQueueDrain(options: {
  queuedMessages: QueuedPrompt[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<QueuedPrompt[]>>;
  commandInFlightRef: React.MutableRefObject<boolean>;
  pendingQuestion: unknown;
  pendingConnectProvider: unknown;
  agentWizard: unknown;
  toolStateIsProcessing: boolean;
  pendingApprovalCount: number;
  submitCommand: (text: string) => Promise<boolean>;
  blocked?: boolean;
}): void {
  const {
    queuedMessages,
    setQueuedMessages,
    commandInFlightRef,
    pendingQuestion,
    pendingConnectProvider,
    agentWizard,
    toolStateIsProcessing,
    pendingApprovalCount,
    submitCommand,
    blocked = false,
  } = options;

  useEffect(() => {
    if (
      commandInFlightRef.current ||
      blocked ||
      toolStateIsProcessing ||
      pendingApprovalCount > 0 ||
      pendingQuestion ||
      pendingConnectProvider ||
      agentWizard ||
      queuedMessages.length === 0 ||
      queuedMessages[0]?.status !== 'queued'
    )
      return;
    const nextMessage = queuedMessages[0];
    setQueuedMessages((pending) =>
      pending.map((message) =>
        message.id === nextMessage.id ? { ...message, status: 'sending', error: undefined } : message,
      ),
    );
    void submitCommand(nextMessage.text).then((succeeded) => {
      setQueuedMessages((pending) => succeeded
        ? pending.filter((message) => message.id !== nextMessage.id)
        : pending.map((message) => message.id === nextMessage.id
          ? { ...message, status: 'failed', error: 'The prompt could not be submitted.' }
          : message));
    }).catch((error) => {
      setQueuedMessages((pending) => pending.map((message) => message.id === nextMessage.id
        ? { ...message, status: 'failed', error: error instanceof Error ? error.message : String(error) }
        : message));
    });
  }, [
    pendingConnectProvider,
    agentWizard,
    pendingQuestion,
    queuedMessages,
    submitCommand,
    blocked,
    toolStateIsProcessing,
    pendingApprovalCount,
  ]);
}

