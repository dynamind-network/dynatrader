/**
 * JSON-RPC Gateway Module
 *
 * Provides a JSON-RPC 2.0 server that bridges DynaTrader's agent core
 * with external clients over stdin/stdout.
 */

export { JsonRpcServer } from "./server";
export type { JsonRpcServerConfig } from "./server";

export {
  JsonRpcErrorCodes,
} from "./types";
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ServerEvent,
  MessageDeltaEvent,
  ToolStartEvent,
  ToolCompleteEvent,
  ApprovalRequestEvent,
  ThinkingEvent,
  ErrorEvent,
  SessionUpdateEvent,
  PlanModeEvent,
  PlanStepUpdateEvent,
} from "./types";

export { RpcMethods, RpcEvents } from "./protocol";
export type {
  RpcMethodName,
  RpcEventName,
  SessionCreateParams,
  SessionDeleteParams,
  SessionHistoryParams,
  SessionSwitchParams,
  PromptSubmitParams,
  PromptCancelParams,
  ModelSwitchParams,
  ModelListParams,
  ModelActiveParams,
  ModelResetParams,
  AgentStateParams,
  SessionCreateResult,
  SessionDeleteResult,
  SessionListItem,
  SessionListResult,
  ConversationMessageRPC,
  SessionHistoryResult,
  SessionSwitchResult,
  PromptSubmitResult,
  PromptCancelResult,
  ModelSwitchResult,
  ModelListItem,
  ModelListResult,
  ModelActiveResult,
  ModelResetResult,
  AgentStateResult,
  GoalManageParams,
  GoalManageResult,
  GoalManageAction,
  GoalSummaryRPC,
} from "./protocol";
