/**
 * Hook Types for DynaMind Terminal
 *
 * Defines all hook-related types for DynaMind's hook system.
 */

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "SessionStart"
  | "SessionEnd"
  | "Setup"
  | "SubagentStart"
  | "SubagentStop"
  | "TeammateIdle"
  | "TaskCreated"
  | "TaskCompleted"
  | "UserPromptSubmit"
  | "Notification"
  | "Elicitation"
  | "ElicitationResult"
  | "PermissionRequest"
  | "PermissionDenied"
  | "ConfigChange"
  | "CwdChanged"
  | "FileChanged"
  | "InstructionsLoaded";

export const hookEvents: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
  "Setup",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "UserPromptSubmit",
  "Notification",
  "Elicitation",
  "ElicitationResult",
  "PermissionRequest",
  "PermissionDenied",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "InstructionsLoaded",
];

export type HookShellType = "bash" | "powershell";

export interface BaseHookCommand {
  type: string;
  if?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
}

export interface CommandHook extends BaseHookCommand {
  type: "command";
  command: string;
  shell?: HookShellType;
  async?: boolean;
  asyncRewake?: boolean;
}

export interface PromptHook extends BaseHookCommand {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface HttpHook extends BaseHookCommand {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

export interface AgentHook extends BaseHookCommand {
  type: "agent";
  prompt: string;
  model?: string;
}

export type HookCommand = CommandHook | PromptHook | HttpHook | AgentHook;

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  message?: string;
  error?: string;
}

export interface HookBlockingError {
  blockingError: string;
  command: string;
}

export interface HookResultMessage {
  type: string;
  hookName?: string;
  toolUseID?: string;
  hookEvent?: HookEvent;
  content?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  blockingError?: HookBlockingError;
}

export interface HookResult {
  message?: HookResultMessage;
  systemMessage?: string;
  blockingError?: HookBlockingError;
  outcome: "success" | "blocking" | "non_blocking_error" | "cancelled";
  preventContinuation?: boolean;
  stopReason?: string;
  permissionBehavior?: "ask" | "deny" | "allow" | "passthrough";
  hookPermissionDecisionReason?: string;
  additionalContext?: string;
  initialUserMessage?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  retry?: boolean;
}

export interface AsyncHookResult extends HookResult {
  async: true;
  asyncTimeout?: number;
}

export interface SyncHookJSONOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    initialUserMessage?: string;
    watchPaths?: string[];
    updatedMCPToolOutput?: unknown;
    retry?: boolean;
    action?: string;
    content?: unknown;
    decision?: {
      behavior: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
    };
  };
}

export interface AsyncHookJSONOutput {
  async: true;
  asyncTimeout?: number;
}

export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

export function isAsyncHookJSONOutput(
  output: unknown,
): output is AsyncHookJSONOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "async" in output &&
    output.async === true
  );
}

export function isSyncHookJSONOutput(
  output: unknown,
): output is SyncHookJSONOutput {
  return !isAsyncHookJSONOutput(output);
}

export interface HookMetrics {
  hookId: string;
  hookName: string;
  hookEvent: HookEvent;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  outcome?: string;
  exitCode?: number;
  error?: string;
  async: boolean;
}

export interface AggregatedHookMetrics {
  totalHooks: number;
  successfulHooks: number;
  failedHooks: number;
  blockedHooks: number;
  totalDurationMs: number;
  averageDurationMs: number;
  byEvent: Record<HookEvent, number>;
  byType: Record<string, number>;
}

export interface RegisteredHook {
  id: string;
  event: HookEvent;
  matcher: string;
  hook: HookCommand;
  enabled: boolean;
  priority: number;
}

export interface HookMatchResult {
  hooks: RegisteredHook[];
  totalCount: number;
  asyncCount: number;
}

