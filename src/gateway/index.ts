/**
 * Dyna-Trader Gateway Package
 *
 * Gateway integration modules including Discord gateway,
 * gateway service for managing multiple plugins, and
 * core gateway infrastructure.
 */

export { DiscordGateway } from "./discord-gateway";
export type {
  DiscordConfig,
  GatewayStatus,
  MessageCallback,
} from "./discord-gateway";

export { GatewayService, DiscordPlugin } from "./gateway-service";
export type {
  GatewayEvent,
  GatewayPlugin,
  DiscordPluginConfig,
} from "./gateway-service";

export {
  buildGatewayRuntimeStatus,
  resolveGatewayTarget,
  resolveGatewayRuntimeConfig,
  sendGatewayMessage,
  validateGatewayLaunchRequirements,
} from "./runtime-gateway";
export type {
  GatewayChannelRuntimeStatus,
  GatewayLaunchRequirements,
  GatewayRuntimeStatus,
  ResolvedGatewayRuntimeConfig,
  GatewaySendRequest,
  GatewayTarget,
} from "./runtime-gateway";

export { ApprovalManager } from "./telegram/approval-manager";
export type {
  ApprovalChoice,
  PendingApproval,
  RiskLevel,
  DangerousPattern,
} from "./telegram/approval-manager";

// JSON-RPC Gateway (stdin/stdout transport)
export { JsonRpcServer } from "./json-rpc/server";
export type { JsonRpcServerConfig } from "./json-rpc/server";
export { RpcMethods, RpcEvents } from "./json-rpc/protocol";
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
} from "./json-rpc/protocol";
export { JsonRpcErrorCodes } from "./json-rpc/types";
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
} from "./json-rpc/types";
