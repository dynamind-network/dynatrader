import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentLoop, ExecutionMode } from '../../index.js';

export interface AgentStateResult {
  agentLoop: AgentLoop | null;
  executionMode: ExecutionMode;
  resolvedApiKeys: Record<string, string>;
  currentModel: string;
  agentLoopRef: React.MutableRefObject<AgentLoop | null>;
  resolvedApiKeysRef: React.MutableRefObject<Record<string, string>>;
  setCurrentModel: (model: string) => void;
  applyExecutionMode: (mode: ExecutionMode) => void;
  refreshApiKeys: () => Promise<Record<string, string>>;
  pendingConnectProvider: string | null;
  setPendingConnectProvider: (provider: string | null) => void;
}

export function useAgentState(
  initialApiKeys: Record<string, string>,
  initialModel: string,
  cwd: string
): AgentStateResult {
  const [agentLoop, setAgentLoop] = useState<AgentLoop | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('normal');
  const [resolvedApiKeys, setResolvedApiKeys] = useState(initialApiKeys);
  const [currentModel, setCurrentModel] = useState(initialModel);
  const [pendingConnectProvider, setPendingConnectProvider] = useState<string | null>(null);

  const agentLoopRef = useRef(agentLoop);
  const resolvedApiKeysRef = useRef(resolvedApiKeys);

  useEffect(() => {
    agentLoopRef.current = agentLoop;
  }, [agentLoop]);

  useEffect(() => {
    resolvedApiKeysRef.current = resolvedApiKeys;
  }, [resolvedApiKeys]);

  const applyExecutionMode = useCallback(
    (mode: ExecutionMode) => {
      setExecutionMode(mode);
      agentLoop?.setExecutionMode(mode);
    },
    [agentLoop]
  );

  const refreshApiKeys = useCallback(async () => {
    const { Auth, PROVIDERS } = await import('../../index.js');
    const nextKeys = Object.fromEntries(
      await Promise.all(
        Object.keys(PROVIDERS).map(async (provider) => {
          const auth = await Auth.get(provider);
          const key = auth && auth.type === 'api' && typeof auth.key === 'string' ? auth.key : '';
          return [provider, key];
        })
      )
    ) as Record<string, string>;
    setResolvedApiKeys(nextKeys);
    return nextKeys;
  }, []);

  useEffect(() => {
    void refreshApiKeys();
  }, [refreshApiKeys]);

  return {
    agentLoop,
    executionMode,
    resolvedApiKeys,
    currentModel,
    agentLoopRef,
    resolvedApiKeysRef,
    setCurrentModel,
    applyExecutionMode,
    refreshApiKeys,
    pendingConnectProvider,
    setPendingConnectProvider,
  };
}

