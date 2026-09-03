import { useState, useRef } from 'react';
import type { AgentLoop } from '../../core/agent-loop.js';
import { getGitStatus, type GitStatus } from '../../services/GitService.js';
import { getContextUsage, type ContextUsage } from '../../services/ContextUsageService.js';
import { useAbortableEffect } from '../utils/abortController.js';

export interface StatusPollingResult {
  gitStatus: GitStatus | null;
  contextUsage: ContextUsage | null;
}

export function useStatusPolling(
  cwd: string,
  agentLoop: AgentLoop | null,
  currentModel: string
): StatusPollingResult {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const prevContextUsageRef = useRef<ContextUsage | null>(null);

  useAbortableEffect(
    (signal) => {
      const poll = async () => {
        try {
          const status = await getGitStatus(cwd);
          if (!signal.aborted) setGitStatus(status);
        } catch {
          if (!signal.aborted) setGitStatus(null);
        }
      };
      void poll();
      const interval = setInterval(poll, 5000);

      signal.addEventListener(
        'abort',
        () => {
          clearInterval(interval);
        },
        { once: true }
      );

      return () => {
        clearInterval(interval);
      };
    },
    [cwd]
  );

  useAbortableEffect(
    (signal) => {
      if (!agentLoop) {
        return;
      }
      const update = () => {
        const messages = agentLoop.getConversation();
        const usage = getContextUsage(messages, currentModel);
        if (usage) {
          prevContextUsageRef.current = usage;
          setContextUsage(usage);
        } else if (prevContextUsageRef.current) {
          setContextUsage(prevContextUsageRef.current);
        }
      };
      update();
      const interval = setInterval(update, 5000);

      signal.addEventListener(
        'abort',
        () => {
          clearInterval(interval);
        },
        { once: true }
      );

      return () => {
        clearInterval(interval);
      };
    },
    [agentLoop, currentModel]
  );

  return { gitStatus, contextUsage };
}
