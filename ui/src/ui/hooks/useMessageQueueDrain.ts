import { useEffect } from 'react';

/**
 * Drains queued messages one at a time when the agent is idle.
 *
 * Waits until no command is in flight, no tool is processing,
 * no pending approvals/questions/wizards exist, then submits
 * the next queued message.
 */
export function useMessageQueueDrain(options: {
  queuedMessages: string[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<string[]>>;
  commandInFlightRef: React.MutableRefObject<boolean>;
  pendingQuestion: unknown;
  pendingConnectProvider: unknown;
  agentWizard: unknown;
  toolStateIsProcessing: boolean;
  pendingApprovalCount: number;
  submitCommand: (text: string) => Promise<void>;
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
  } = options;

  useEffect(() => {
    if (
      commandInFlightRef.current ||
      toolStateIsProcessing ||
      pendingApprovalCount > 0 ||
      pendingQuestion ||
      pendingConnectProvider ||
      agentWizard ||
      queuedMessages.length === 0
    )
      return;
    const [nextMessage, ...remainingMessages] = queuedMessages;
    setQueuedMessages(remainingMessages);
    void submitCommand(nextMessage);
  }, [
    pendingConnectProvider,
    agentWizard,
    pendingQuestion,
    queuedMessages,
    submitCommand,
    toolStateIsProcessing,
    pendingApprovalCount,
  ]);
}
