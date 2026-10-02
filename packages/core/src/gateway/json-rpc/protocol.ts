/**
 * JSON-RPC Protocol Definitions
 *
 * Canonical method names and event types for the DynaTrader JSON-RPC protocol.
 * All RPC methods, params, and event payloads are defined here as const objects
 * so clients and the server share a single source of truth.
 */

// ---------------------------------------------------------------------------
// RPC Methods (request/response)
// ---------------------------------------------------------------------------

export const RpcMethods = {
  /** Create a new conversation session. */
  SESSION_CREATE: "session.create",
  /** Delete a session by ID. */
  SESSION_DELETE: "session.delete",
  /** List all sessions. */
  SESSION_LIST: "session.list",
  /** Get message history for a session (defaults to active session). */
  SESSION_HISTORY: "session.history",
  /** Switch to an existing session. */
  SESSION_SWITCH: "session.switch",
  /** Restore the UI-persisted transcript into the agent's active session store. */
  SESSION_RESTORE: "session.restore",

  /** Submit a user prompt to the agent (non-streaming). */
  PROMPT_SUBMIT: "prompt.submit",
  /** Cancel the current in-progress prompt. */
  PROMPT_CANCEL: "prompt.cancel",
  /** Change approval behavior during an active or future prompt. */
  PROMPT_APPROVAL_MODE_SET: "prompt.approval_mode.set",
  CONVERSATION_COMPACT: "conversation.compact",
  TOOL_LIST: "tool.list",
  MEMORY_SEARCH: "memory.search",
  MEMORY_WRITE: "memory.write",
  MEMORY_STATS: "memory.stats",
  DECISION_METRICS: "decision.metrics",
  /** Read or update a persistent goal owned by the Core AgentCore. */
  GOAL_MANAGE: "goal.manage",
  AGENT_DELEGATE: "agent.delegate",
  AGENT_DELEGATE_START: "agent.delegate.start",
  AGENT_DELEGATE_STATUS: "agent.delegate.status",
  AGENT_DELEGATE_CANCEL: "agent.delegate.cancel",
  AGENT_DELEGATE_LIST: "agent.delegate.list",
  TOOL_POLICY_SET: "tool.policy.set",
  APPROVAL_RESOLVE: "approval.resolve",

  /** Switch the active model (e.g. "openai/gpt-4o"). */
  MODEL_SWITCH: "model.switch",
  /** List all available models. */
  MODEL_LIST: "model.list",
  /** Get the currently active model. */
  MODEL_ACTIVE: "model.active",
  /** Reset model to auto-routing. */
  MODEL_RESET: "model.reset",

  /** Get the current agent state (idle, running, etc.). */
  AGENT_STATE: "agent.state",

  /** Set the active persona for the current session. */
  SESSION_SET_PERSONA: "session.set_persona",
} as const;

export type RpcMethodName = (typeof RpcMethods)[keyof typeof RpcMethods];

// ---------------------------------------------------------------------------
// RPC Method Parameter Types
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  name?: string;
}

export interface SessionDeleteParams {
  sessionId: string;
}

export interface SessionListParams {
  // No params needed
}

export interface SessionHistoryParams {
  sessionId?: string;
}

export interface SessionSwitchParams {
  sessionId: string;
}

export interface SessionRestoreParams {
  sessionId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }>;
}

export interface PromptSubmitParams {
  message: string;
  sessionId?: string;
  templateName?: string;
  approvalMode?: 'default' | 'auto_edit' | 'yolo';
}

export interface PromptCancelParams {
  // No params needed
}

export interface ModelSwitchParams {
  modelId: string;
}

export interface ModelListParams {
  // No params needed
}

export interface ModelActiveParams {
  // No params needed
}

export interface ModelResetParams {
  // No params needed
}

export interface AgentStateParams {
  // No params needed
}

export type GoalManageAction = 'set' | 'list' | 'status' | 'pause' | 'resume' | 'complete' | 'clear';
export interface GoalManageParams {
  action: GoalManageAction;
  objective?: string;
}
export interface GoalSummaryRPC {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'failed' | 'paused';
  sessionId: string;
  progress: { stepsCompleted: number; totalSteps: number; percentComplete: number };
  tokenBudget: number;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}
export interface GoalManageResult {
  action: GoalManageAction;
  changed: boolean;
  goal?: GoalSummaryRPC | null;
  goals?: GoalSummaryRPC[];
}

// ---------------------------------------------------------------------------
// RPC Result Types
// ---------------------------------------------------------------------------

export interface SessionCreateResult {
  sessionId: string;
  name: string;
  createdAt: string;
}

export interface SessionDeleteResult {
  deleted: boolean;
  sessionId: string;
}

export interface SessionListItem {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListResult {
  sessions: SessionListItem[];
}

export interface ConversationMessageRPC {
  role: string;
  content: string | null;
  timestamp: string;
}

export interface SessionHistoryResult {
  sessionId: string;
  messages: ConversationMessageRPC[];
}

export interface SessionSwitchResult {
  sessionId: string;
  name: string;
  messageCount: number;
}

export interface PromptSubmitResult {
  content: string;
  state: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
  compacted: boolean;
}

export interface PromptCancelResult {
  cancelled: boolean;
}

export interface ConversationCompactResult { compacted: boolean; message: string; messageCount: number }
export interface ToolListResult { tools: Array<{ name: string; description: string; category: string; readOnly?: boolean; riskLevel?: string }> }
export interface AgentDelegateParams { task: string; agent?: string; context?: Record<string, unknown>; sessionId?: string }
export interface AgentDelegateResult { agent?: string; result: unknown }
export type DelegatedTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export interface DelegatedTask { taskId: string; agent: string; task: string; sessionId: string; status: DelegatedTaskStatus; createdAt: string; completedAt?: string; result?: unknown; error?: string }
export interface AgentDelegateStartResult { task: DelegatedTask }
export interface AgentDelegateStatusResult { task?: DelegatedTask }
export interface AgentDelegateCancelResult { cancelled: boolean; task?: DelegatedTask }
export interface AgentDelegateListResult { tasks: DelegatedTask[] }
export interface ToolPolicySetParams { sessionId?: string; allowedTools?: string[]; disallowedTools?: string[] }
export interface ToolPolicySetResult { configured: true; availableTools: string[] }
export interface MemorySearchParams { scope: string; text: string; topK?: number }
export interface MemorySearchResult { results: Array<{ id: string; score: number; payload: unknown; timestamp: string }>; count: number; scope: string; query: string }
export interface MemoryWriteParams { scope: string; kind: string; payload: Record<string, unknown>; summary?: string }
export interface MemoryWriteResult { id: string; scope: string; kind: string }
export interface MemoryStatsResult { summary: string }
export interface DecisionMetricsResult { metrics: import('../../agent/core/decision-models').DecisionMetrics }
export interface ApprovalResolveParams { requestId: string; approved: boolean }
export interface ApprovalResolveResult { resolved: boolean }

export interface SessionSetPersonaParams { persona: string | null }
export interface SessionSetPersonaResult { persona: string | null; sessionId: string }

export interface ModelSwitchResult {
  switched: boolean;
  previousModel: string;
  newModel: string;
}

export interface ModelListItem {
  id: string;
  provider: string;
  supportsStreaming: boolean;
}

export interface ModelListResult {
  models: ModelListItem[];
}

export interface ModelActiveResult {
  activeModel: string;
}

export interface ModelResetResult {
  reset: boolean;
}

export interface AgentStateResult {
  state: string;
}

// ---------------------------------------------------------------------------
// RPC Event Types (notifications: server -> client, no id field)
// ---------------------------------------------------------------------------

export const RpcEvents = {
  /** Streaming content delta from the model. */
  MESSAGE_DELTA: "message.delta",
  /** A tool call has started executing. */
  TOOL_START: "tool.start",
  /** A tool call has completed. */
  TOOL_COMPLETE: "tool.complete",
  /** The agent is requesting human approval for an action. */
  APPROVAL_REQUEST: "approval.request",
  /** Model is generating thinking/reasoning content. */
  THINKING: "thinking",
  /** An error occurred in the agent. */
  ERROR: "error",
  /** A session was created, deleted, or switched. */
  SESSION_UPDATE: "session.update",
  AGENT_TASK_UPDATE: "agent.task.update",
  AGENT_ACTIVITY: "agent.activity",
} as const;

export type RpcEventName = (typeof RpcEvents)[keyof typeof RpcEvents];
