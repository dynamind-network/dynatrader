export interface ToolState {
  isProcessing: boolean;
  currentTool: string | null;
  activeTools: string[];
  pendingApprovals: Array<{
    toolName: string;
    input: any;
    reason?: string;
    resolve: (value: boolean) => void;
    timestamp: number;
  }>;
  lastToolChange: number;
  toolExecutionHistory: Array<{
    toolName: string;
    startTime: number;
    endTime?: number;
    success?: boolean;
  }>;
}

export interface ToolStateContextType {
  state: ToolState;
  startProcessing: () => void;
  stopProcessing: () => void;
  setCurrentTool: (tool: string | null) => void;
  setActiveTools: (tools: string[]) => void;
  addPendingApproval: (toolName: string, input: any, resolve: (value: boolean) => void, reason?: string) => void;
  removePendingApproval: (toolName: string) => void;
  approveTool: (toolName: string) => void;
  rejectTool: (toolName: string) => void;
  addToolToHistory: (toolName: string) => void;
  finishToolInHistory: (toolName: string, success: boolean) => void;
  clearHistory: () => void;
  reset: () => void;
  // Validation helpers
  validateState: () => boolean;
  getToolExecutionTime: (toolName: string) => number | null;
  isToolActive: (toolName: string) => boolean;
}

export interface ToolStatusSlice {
  isProcessing: boolean;
  activeTools: string[];
}

export interface ToolApprovalSlice {
  pendingApprovals: ToolState['pendingApprovals'];
  approveTool: (toolName: string) => void;
  rejectTool: (toolName: string) => void;
}

export interface ToolHistorySlice {
  toolExecutionHistory: ToolState['toolExecutionHistory'];
}

export const initialState: ToolState = {
  isProcessing: false,
  currentTool: null,
  activeTools: [],
  pendingApprovals: [],
  lastToolChange: 0,
  toolExecutionHistory: [],
};

/**
 * Internal validation function for tool state
 */
export function validateToolStateInternal(currentState: ToolState): boolean {
  const issues: string[] = [];

  // Check for inconsistent processing state
  if (
    currentState.isProcessing &&
    currentState.activeTools.length === 0 &&
    !currentState.currentTool
  ) {
    issues.push('Processing state true but no active tools or current tool');
  }

  // Check for stale pending approvals (older than 5 minutes)
  const now = Date.now();
  const staleApprovals = currentState.pendingApprovals.filter((p) => now - p.timestamp > 300000);
  if (staleApprovals.length > 0) {
    issues.push(`Stale pending approvals: ${staleApprovals.length}`);
  }

  if (issues.length > 0) {
    console.warn('Tool state validation issues:', issues);
    return false;
  }

  return true;
}

/**
 * Enhanced event handler for agent loop events
 */
export function createAgentLoopEventHandler(toolState: ToolStateContextType) {
  return {
    handleEvent: (event: any) => {
      switch (event.type) {
        case 'thinking':
          toolState.startProcessing();
          toolState.setCurrentTool(null);
          toolState.setActiveTools([]);
          break;

        case 'tool_start':
          toolState.startProcessing();
          if (event.toolName && typeof event.toolName === 'string') {
            const nextTools = Array.from(new Set([...toolState.state.activeTools, event.toolName]));
            toolState.setCurrentTool(event.toolName);
            toolState.setActiveTools(nextTools);
            toolState.addToolToHistory(event.toolName);
          } else {
            console.warn('tool_start event missing valid toolName:', event);
          }
          break;

        case 'tool_batch':
          if (event.batch?.toolNames) {
            toolState.startProcessing();
            toolState.setActiveTools(event.batch.toolNames);
            toolState.setCurrentTool(event.batch.toolNames[0] ?? null);
          }
          break;

        case 'tool_end':
          if (event.toolName && typeof event.toolName === 'string') {
            toolState.finishToolInHistory(event.toolName, event.result?.success !== false);
            // Don't immediately clear tools - let the animation handle this
            if (toolState.state.currentTool === event.toolName) {
              toolState.setCurrentTool(null);
            }
            toolState.setActiveTools(
              toolState.state.activeTools.filter((tool) => tool !== event.toolName)
            );
          } else {
            console.warn('tool_end event missing valid toolName:', event);
          }
          break;

        case 'approval_request':
          toolState.startProcessing();
          break;

        case 'approval_auto_resolved':
          toolState.approveTool(event.toolName);
          break;

        case 'loop_warning':
          if (event.message) {
            console.warn('Agent loop warning:', event.message);
          }
          break;

        case 'text':
          // Handle streaming text if needed
          break;

        case 'error':
          if (event.toolName) {
            toolState.finishToolInHistory(event.toolName, false);
          }
          toolState.stopProcessing();
          break;

        case 'done':
          toolState.stopProcessing();
          break;

        default:
          // Log unknown events for debugging
          if (process.env.NODE_ENV === 'development') {
            console.log('Unknown agent event:', event);
          }
      }
    },

    handleApprovalRequired: (toolName: string, input: any, reason?: string): Promise<boolean> => {
      return new Promise((resolve) => {
        toolState.addPendingApproval(toolName, input, resolve, reason);
      });
    },

    handleApprovalComplete: (toolName: string, approved: boolean) => {
      toolState.removePendingApproval(toolName);
      if (approved) {
        toolState.addToolToHistory(toolName);
      } else {
        toolState.finishToolInHistory(toolName, false);
      }
    },
  };
}

