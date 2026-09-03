import { useState, useEffect, useMemo, useCallback, startTransition } from 'react';
import { JsonRpcClient } from '../../rpc/client.js';
import type { Message } from '../types.js';
import { resolveDynatraderLaunchSpec } from '../../core/dynatrader-launcher.js';

export interface ToolExecution {
  callId?: string;
  name: string;
  input: unknown;
  status: 'running' | 'complete' | 'error';
  result?: unknown;
}

export interface ApprovalPending {
  requestId: string;
  toolName: string;
  reason: string;
}

export interface UseAgentResult {
  messages: Message[];
  streamingText: string;
  isStreaming: boolean;
  toolExecutions: ToolExecution[];
  approvalPending: ApprovalPending | null;
  submit: (message: string) => Promise<void>;
  approve: (approved: boolean) => Promise<void>;
  cancel: () => Promise<void>;
}

export function useAgent(sessionId: string): UseAgentResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toolExecutions, setToolExecutions] = useState<ToolExecution[]>([]);
  const [approvalPending, setApprovalPending] = useState<ApprovalPending | null>(null);

  const client = useMemo(() => {
    const launchSpec = resolveDynatraderLaunchSpec();
    return new JsonRpcClient(launchSpec.command, launchSpec.args);
  }, []);

  useEffect(() => {
    client.on('transport.error', (value) => {
      const message = value instanceof Error ? value.message : String(value);
      startTransition(() => {
        setIsStreaming(false);
        setStreamingText('');
        setToolExecutions([]);
        setApprovalPending(null);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Runtime error: ${message}`, timestamp: new Date() },
        ]);
      });
    });

    client.on('error', (params) => {
      const message =
        typeof params === 'object' && params !== null && 'message' in params
          ? String((params as { message?: unknown }).message)
          : String(params);
      startTransition(() => {
        setIsStreaming(false);
        setStreamingText('');
        setToolExecutions([]);
        setApprovalPending(null);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Agent error: ${message}`, timestamp: new Date() },
        ]);
      });
    });

    client.on('message.delta', (params) => {
      const { content } = params as { content: string };
      startTransition(() => {
        setStreamingText((prev) => prev + content);
      });
    });

    client.on('message.complete', (params) => {
      const { message } = params as { message: Message };
      startTransition(() => {
        setMessages((prev) => [...prev, message]);
        setStreamingText('');
        setIsStreaming(false);
      });
    });

    client.on('tool.start', (params) => {
      const { toolName, input, toolCallId } = params as {
        toolName: string;
        input: unknown;
        toolCallId?: string;
      };
      startTransition(() => {
        setToolExecutions((prev) => [
          ...prev,
          { callId: toolCallId, name: toolName, input, status: 'running' },
        ]);
      });
    });

    client.on('tool.complete', (params) => {
      const { toolName, result, toolCallId, success, error } = params as {
        toolName: string;
        result: unknown;
        toolCallId?: string;
        success?: boolean;
        error?: string;
      };
      const isError =
        success === false ||
        Boolean(error) ||
        (typeof result === 'object' &&
          result !== null &&
          'error' in result &&
          Boolean((result as { error?: unknown }).error));
      startTransition(() => {
        setToolExecutions((prev) =>
          prev.some(
            (t) =>
              t.status === 'running' && (toolCallId ? t.callId === toolCallId : t.name === toolName)
          )
            ? prev.map((t) =>
                t.status === 'running' && (toolCallId ? t.callId === toolCallId : t.name === toolName)
                  ? {
                      ...t,
                      status: isError ? 'error' : 'complete',
                      result: isError ? (error ?? result) : result,
                    }
                  : t
              )
            : [
                ...prev,
                {
                  callId: toolCallId,
                  name: toolName,
                  input: {},
                  status: isError ? 'error' : 'complete',
                  result: isError ? (error ?? result) : result,
                },
              ]
        );
      });
    });

    client.on('approval.request', (params) => {
      const { requestId, toolName, reason } = params as {
        requestId: string;
        toolName: string;
        reason: string;
      };
      startTransition(() => {
        setApprovalPending({ requestId, toolName, reason });
      });
    });

    return () => {
      client.close();
    };
  }, [client]);

  const submit = useCallback(
    async (message: string) => {
      setMessages((prev) => [...prev, { role: 'user', content: message, timestamp: new Date() }]);
      startTransition(() => {
        setIsStreaming(true);
        setStreamingText('');
        setToolExecutions([]);
      });
      try {
        await client.call('prompt.submit', { sessionId, message });
      } catch (error) {
        startTransition(() => {
          setIsStreaming(false);
          setStreamingText('');
        });
        throw error;
      }
    },
    [client, sessionId]
  );

  const approve = useCallback(
    async (approved: boolean) => {
      if (approvalPending) {
        try {
          await client.call('approval.resolve', {
            requestId: approvalPending.requestId,
            approved,
          });
          setApprovalPending(null);
        } catch (error) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date(),
            },
          ]);
          throw error;
        }
      }
    },
    [client, approvalPending]
  );

  const cancel = useCallback(async () => {
    startTransition(() => {
      setIsStreaming(false);
      setStreamingText('');
    });
    try {
      await client.call('prompt.cancel', { sessionId });
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        },
      ]);
      throw error;
    }
  }, [client, sessionId]);

  return {
    messages,
    streamingText,
    isStreaming,
    toolExecutions,
    approvalPending,
    submit,
    approve,
    cancel,
  };
}
