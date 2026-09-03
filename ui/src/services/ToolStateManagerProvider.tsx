import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type {
  ToolState,
  ToolStateContextType,
  ToolStatusSlice,
  ToolApprovalSlice,
  ToolHistorySlice,
} from './ToolStateManager.js';

const initialToolState: ToolState = {
  isProcessing: false,
  currentTool: null,
  activeTools: [],
  pendingApprovals: [],
  lastToolChange: 0,
  toolExecutionHistory: [],
};

// ---------------------------------------------------------------------------
// Backward-compatible context (kept for useToolState consumers)
// ---------------------------------------------------------------------------
const ToolStateContext = createContext<ToolStateContextType | null>(null);

// ---------------------------------------------------------------------------
// Focused sub-contexts
// ---------------------------------------------------------------------------
const ToolStatusContext = createContext<ToolStatusSlice | null>(null);
const ToolApprovalContext = createContext<ToolApprovalSlice | null>(null);
const ToolHistoryContext = createContext<ToolHistorySlice | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
interface ToolStateProviderProps {
  children: ReactNode;
}

export function ToolStateProvider({ children }: ToolStateProviderProps) {
  const [state, setState] = useState<ToolState>(initialToolState);
  const validationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- actions (unchanged business logic) ---

  const startProcessing = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isProcessing: true,
      lastToolChange: Date.now(),
    }));
  }, []);

  const stopProcessing = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isProcessing: false,
      currentTool: null,
    }));
  }, []);

  const setCurrentTool = useCallback((tool: string | null) => {
    setState((prev) => ({
      ...prev,
      currentTool: tool,
      lastToolChange: Date.now(),
    }));
  }, []);

  const setActiveTools = useCallback((tools: string[]) => {
    setState((prev) => ({
      ...prev,
      activeTools: tools,
      lastToolChange: Date.now(),
    }));
  }, []);

  const addPendingApproval = useCallback(
    (toolName: string, input: unknown, resolve: (value: boolean) => void) => {
      setState((prev) => ({
        ...prev,
        pendingApprovals: [
          ...prev.pendingApprovals,
          { toolName, input, resolve, timestamp: Date.now() },
        ],
      }));
    },
    []
  );

  const removePendingApproval = useCallback((toolName: string) => {
    setState((prev) => ({
      ...prev,
      pendingApprovals: prev.pendingApprovals.filter((p) => p.toolName !== toolName),
    }));
  }, []);

  const approveTool = useCallback((toolName: string) => {
    setState((prev) => {
      const approval = prev.pendingApprovals.find((p) => p.toolName === toolName);
      if (approval) {
        approval.resolve(true);
        return {
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter((p) => p.toolName !== toolName),
        };
      }
      return prev;
    });
  }, []);

  const rejectTool = useCallback((toolName: string) => {
    setState((prev) => {
      const approval = prev.pendingApprovals.find((p) => p.toolName === toolName);
      if (approval) {
        approval.resolve(false);
        return {
          ...prev,
          pendingApprovals: prev.pendingApprovals.filter((p) => p.toolName !== toolName),
        };
      }
      return prev;
    });
  }, []);

  const addToolToHistory = useCallback((toolName: string) => {
    setState((prev) => ({
      ...prev,
      toolExecutionHistory: [
        ...prev.toolExecutionHistory.slice(-99), // Keep last 100
        { toolName, startTime: Date.now() },
      ],
    }));
  }, []);

  const finishToolInHistory = useCallback((toolName: string, success?: boolean) => {
    setState((prev) => ({
      ...prev,
      toolExecutionHistory: prev.toolExecutionHistory.map((entry) =>
        entry.toolName === toolName && !entry.endTime
          ? { ...entry, endTime: Date.now(), success }
          : entry
      ),
    }));
  }, []);

  const clearHistory = useCallback(() => {
    setState((prev) => ({
      ...prev,
      toolExecutionHistory: [],
    }));
  }, []);

  const reset = useCallback(() => {
    setState(initialToolState);
  }, []);

  // Validation helpers
  const validateState = useCallback((): boolean => {
    const issues: string[] = [];

    if (state.isProcessing && state.activeTools.length === 0 && !state.currentTool) {
      issues.push('Processing state true but no active tools or current tool');
    }

    const now = Date.now();
    const staleApprovals = state.pendingApprovals.filter((p) => now - p.timestamp > 300000);
    if (staleApprovals.length > 0) {
      issues.push(`Stale pending approvals: ${staleApprovals.length}`);
    }

    if (issues.length > 0) {
      console.warn('Tool state validation issues:', issues);
      return false;
    }

    return true;
  }, [state]);

  const getToolExecutionTime = useCallback(
    (toolName: string): number | null => {
      const entry = state.toolExecutionHistory.find((e) => e.toolName === toolName);
      if (!entry || !entry.endTime) return null;
      return entry.endTime - entry.startTime;
    },
    [state.toolExecutionHistory]
  );

  const isToolActive = useCallback(
    (toolName: string): boolean => {
      return state.activeTools.includes(toolName);
    },
    [state.activeTools]
  );

  // Run validation periodically
  useEffect(() => {
    validationIntervalRef.current = setInterval(() => {
      validateState();
    }, 30000);

    return () => {
      if (validationIntervalRef.current) {
        clearInterval(validationIntervalRef.current);
      }
    };
  }, [validateState]);

  // --- derived slice values (stable references for sub-contexts) ---

  const toolStatusValue: ToolStatusSlice = useMemo(
    () => ({
      isProcessing: state.isProcessing,
      activeTools: state.activeTools,
    }),
    [state.isProcessing, state.activeTools]
  );

  const toolApprovalValue: ToolApprovalSlice = useMemo(
    () => ({
      pendingApprovals: state.pendingApprovals,
      approveTool,
      rejectTool,
    }),
    [state.pendingApprovals, approveTool, rejectTool]
  );

  const toolHistoryValue: ToolHistorySlice = useMemo(
    () => ({
      toolExecutionHistory: state.toolExecutionHistory,
    }),
    [state.toolExecutionHistory]
  );

  // Backward-compatible full context value
  const value: ToolStateContextType = useMemo(
    () => ({
      state,
      startProcessing,
      stopProcessing,
      setCurrentTool,
      setActiveTools,
      addPendingApproval,
      removePendingApproval,
      approveTool,
      rejectTool,
      addToolToHistory,
      finishToolInHistory,
      clearHistory,
      reset,
      validateState,
      getToolExecutionTime,
      isToolActive,
    }),
    [
      state,
      startProcessing,
      stopProcessing,
      setCurrentTool,
      setActiveTools,
      addPendingApproval,
      removePendingApproval,
      approveTool,
      rejectTool,
      addToolToHistory,
      finishToolInHistory,
      clearHistory,
      reset,
      validateState,
      getToolExecutionTime,
      isToolActive,
    ]
  );

  return (
    <ToolStateContext.Provider value={value}>
      <ToolStatusContext.Provider value={toolStatusValue}>
        <ToolApprovalContext.Provider value={toolApprovalValue}>
          <ToolHistoryContext.Provider value={toolHistoryValue}>
            {children}
          </ToolHistoryContext.Provider>
        </ToolApprovalContext.Provider>
      </ToolStatusContext.Provider>
    </ToolStateContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Backward-compatible hook — returns the full ToolStateContextType. */
export function useToolState(): ToolStateContextType {
  const context = useContext(ToolStateContext);
  if (!context) {
    throw new Error('useToolState must be used within a ToolStateProvider');
  }
  return context;
}

/** Focused hook for isProcessing + activeTools. */
export function useToolStatus(): ToolStatusSlice {
  const context = useContext(ToolStatusContext);
  if (!context) {
    throw new Error('useToolStatus must be used within a ToolStateProvider');
  }
  return context;
}

/** Focused hook for pending approvals + approve/reject actions. */
export function useToolApproval(): ToolApprovalSlice {
  const context = useContext(ToolApprovalContext);
  if (!context) {
    throw new Error('useToolApproval must be used within a ToolStateProvider');
  }
  return context;
}

/** Focused hook for tool execution history. */
export function useToolHistory(): ToolHistorySlice {
  const context = useContext(ToolHistoryContext);
  if (!context) {
    throw new Error('useToolHistory must be used within a ToolStateProvider');
  }
  return context;
}
