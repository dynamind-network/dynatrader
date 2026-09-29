/**
 * JSON-RPC Protocol Types
 *
 * Defines the wire format for JSON-RPC 2.0 communication between
 * the DynaTrader agent and external clients (terminal, web UI, etc.).
 */

// ---------------------------------------------------------------------------
// Request / Response / Notification
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Standard error codes
// ---------------------------------------------------------------------------

export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Authentication required (not standard JSON-RPC, used by DynaTrader) */
  AUTH_ERROR: -32001,
} as const;

// ---------------------------------------------------------------------------
// Event payloads (notifications sent from server -> client)
// ---------------------------------------------------------------------------

export interface MessageDeltaEvent {
  type: "message.delta";
  content: string;
  sessionId: string;
}

export interface ToolStartEvent {
  type: "tool.start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
}

export interface ToolCompleteEvent {
  type: "tool.complete";
  toolCallId: string;
  toolName: string;
  result: unknown;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
}

export interface ApprovalRequestEvent {
  type: "approval.request";
  requestId: string;
  action: string;
  summary: string;
  riskLevel: string;
  sessionId: string;
}

export interface ThinkingEvent {
  type: "thinking";
  content: string;
  sessionId: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  code?: number;
  sessionId: string;
}

export interface SessionUpdateEvent {
  type: "session.update";
  sessionId: string;
  action: "created" | "deleted" | "switched" | "updated" | "persona_changed";
}

export interface PlanModeEvent { type: "plan.mode.entered" | "plan.mode.exited"; sessionId: string; planId?: string; path?: string; status: string }
export interface PlanStepUpdateEvent { type: "plan.step.update"; sessionId: string; planId?: string; step: string; status: string }
export interface AgentTaskUpdateEvent { type: "agent.task.update"; task: import('./protocol').DelegatedTask }
export interface AgentActivityEvent { type: "agent.activity"; agent: string; taskId: string; chunk: import('@dyna/contracts').ModelStreamChunk }

export type ServerEvent =
  | MessageDeltaEvent
  | ToolStartEvent
  | ToolCompleteEvent
  | ApprovalRequestEvent
  | ThinkingEvent
  | ErrorEvent
  | SessionUpdateEvent
  | PlanModeEvent
  | PlanStepUpdateEvent
  | AgentTaskUpdateEvent
  | AgentActivityEvent;
