import { z } from 'zod';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ThinkingContent | ToolUseContent | ToolResultContent;

/**
 * Message type for internal LLM API communication
 * Used by agent-loop, context-manager, providers, etc.
 */
export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  compacted?: boolean;
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export interface ToolCapabilities {
  readOnly: boolean;
  mutatesFiles: boolean;
  mutatesExternalState: boolean;
  canRunInParallel: boolean;
  riskLevel?: RiskLevel;
}

export interface ToolExecutionContext {
  workingDirectory: string;
  userId?: string;
  conversationId: string;
  isSubagent: boolean;
  askQuestion?: (prompt: QuestionPrompt) => Promise<string | null>;
}

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  options: QuestionOption[];
  defaultValue?: string;
  /** If true, user can type custom text as option 5 */
  allowCustomText?: boolean;
}

export interface ToolResult {
  success: boolean;
  output: string;
  modelOutput?: string;
  summary?: string;
  artifacts?: Record<string, unknown>;
}

export interface ToolExecutionRecord {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  approvalRequired: boolean;
  approved: boolean;
  parallelizable: boolean;
  status: 'success' | 'error' | 'cancelled';
  signature: string;
  cached?: boolean;
}

export interface ToolBatchSummary {
  batchId: string;
  toolNames: string[];
  parallel: boolean;
  count: number;
}

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  maxTokens: number;
  maxTurns: number;
  tools: string[];
  temperature?: number;
  onPartialResponse?: (text: string) => void;
  compaction?: {
    auto?: boolean;
    prune?: boolean;
  };
}

export type ToolChoiceMode = 'auto' | 'required';

export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxTurns: number;
  canSpawnSubagents: boolean;
  hidden?: boolean;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error';

export interface AgentResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type RecoveryAction =
  | 'none'
  | 'model_fallback'
  | 'reactive_compact'
  | 'strip_thinking'
  | 'retry_with_guidance'
  | 'escalate_output_tokens';

export interface RecoveryState {
  consecutiveFailures: number;
  lastFailureReason: string | null;
  fallbackModelAttempted: boolean;
  outputTokenEscalationCount: number;
  compactAttempted: boolean;
  softResetAttempted: boolean;
  failuresThisTurn: number;
}

export interface IntentBudget {
  coding: { maxToolCallsPerTurn: number; maxTurns: number };
  research: { maxToolCallsPerTurn: number; maxTurns: number };
  general: { maxToolCallsPerTurn: number; maxTurns: number };
}

export const DEFAULT_INTENT_BUDGETS: IntentBudget = {
  coding: { maxToolCallsPerTurn: 25, maxTurns: 50 },
  research: { maxToolCallsPerTurn: 15, maxTurns: 30 },
  general: { maxToolCallsPerTurn: 10, maxTurns: 20 },
};

export type ApprovalMode = 'default' | 'auto_edit' | 'yolo';

export type ExecutionMode = 'normal' | 'auto-approve';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  affectedResources: string[];
}

export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; result: ToolResult }
  | { type: 'tool_batch'; batch: ToolBatchSummary }
  | {
      type: 'approval_request';
      toolName: string;
      input: Record<string, unknown>;
      reason: string;
    }
  | {
      type: 'loop_warning';
      message: string;
      repeatedSignatures: string[];
    }
  | { type: 'text'; content: string }
  | { type: 'partial'; content: string }
  | { type: 'error'; error: string }
  | { type: 'done'; finalResponse: string }
  | { type: 'plan_interrupted'; reason: 'esc_pressed' | 'user_cancel' }
  | { type: 'plan_mode_entered'; goal?: string }
  | { type: 'plan_mode_exited'; plan?: import('./plan-manager.js').Plan; approved?: boolean }
  | { type: 'plan_step_update'; planId: string; step: import('./plan-manager.js').PlanStep }
  | { type: 'mode_changed'; mode: ExecutionMode };

export interface DynamindConfig {
  apiKey: string;
  model: string;
  maxTurns: number;
  maxContextTokens: number;
  compressionThreshold: number;
  workingDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  subagents: SubagentDefinition[];
}

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  modelOutput: z.string().optional(),
  summary: z.string().optional(),
  artifacts: z.record(z.unknown()).optional(),
});

export const AgentConfigSchema = z.object({
  model: z.string(),
  systemPrompt: z.string(),
  maxTokens: z.number(),
  maxTurns: z.number(),
  tools: z.array(z.string()),
  temperature: z.number().optional(),
  compaction: z
    .object({
      auto: z.boolean().optional(),
      prune: z.boolean().optional(),
    })
    .optional(),
});
