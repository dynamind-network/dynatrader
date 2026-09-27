/**
 * Dyna-Trader Shared Contracts
 *
 * This package defines the core interfaces and types that form the backbone
 * of the Dyna-Trader architecture. All components must adhere to these
 * contracts to ensure type safety and architectural consistency.
 */

import { z } from "zod";

// Trade mode enum
export type TradeMode = "backtest" | "paper" | "live";

// Channel envelope structure
export const ChannelEnvelopeSchema = z.object({
  channel: z.string(),
  senderId: z.string(),
  sessionId: z.string(),
  text: z.string().optional(),
  attachments: z.array(z.object({
    kind: z.enum(["image", "file", "audio"]),
    url: z.string().optional(),
    mimeType: z.string().optional(),
  })).optional(),
  trusted: z.boolean(),
  metadata: z.record(z.unknown()),
});

export interface ChannelEnvelope {
  channel: string;
  senderId: string;
  sessionId: string;
  text?: string;
  attachments?: Array<{
    kind: "image" | "file" | "audio";
    url?: string;
    mimeType?: string;
  }>;
  trusted: boolean;
  metadata: Record<string, unknown>;
}

// Agent turn context
export interface AgentTurnContext {
  now: Date;
  mode: TradeMode;
  accountId: string;
  portfolioId: string;
  correlationId: string;
  sessionId?: string;
}

// Strategy source types
export type StrategySourceKind = "template" | "dsl" | "llm-plan";

export interface StrategySource {
  kind: StrategySourceKind;
  body: string;
  params?: Record<string, unknown>;
}

// Skill manifest contract
export interface SkillManifest {
  id: string;
  venue: string;
  symbol: string;
  timeframe?: string;
  entry: unknown;
  exits: unknown;
  sizing: unknown;
  risk: {
    maxPositionNotional: number;
    maxDailyLoss: number;
    maxOpenOrders: number;
  };
  executionMode: TradeMode;
}

// Memory store interface
export interface MemoryStore {
  put(event: { scope: string; kind: string; payload: unknown; ts: Date }): Promise<void>;
  search(query: { scope: string; text: string; topK?: number; kind?: string; includeArchived?: boolean }): Promise<Array<{ id: string; score: number; payload: unknown; timestamp: Date }>>;
  summarize(scope: { scope: string; from?: Date; to?: Date }): Promise<string>;
  compact(scope: { scope: string }): Promise<void>;
}

// Risk engine interface
export interface RiskEngine {
  evaluateStrategy(ir: SkillManifest, ctx: AgentTurnContext): Promise<{
    decision: "approved" | "rejected" | "manual-approval";
    reasons: string[];
  }>;
  evaluateOrder(intent: OrderIntent, ctx: AgentTurnContext): Promise<RiskDecision>;
}

// Order intent
export interface OrderIntent {
  venue: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop-limit";
  quantity: number;
  price?: number;
  stopPrice?: number;
  limitPrice?: number;
  strategyId: string;
  mode: TradeMode;
}

// Risk decision
export interface RiskDecision {
  decision: "approved" | "rejected" | "manual-approval";
  reasons: string[];
  approvedIntent?: OrderIntent;
}

// Exchange adapter interface
export interface ExchangeAdapter {
  readonly id: string;
  capabilities(): Promise<Record<string, unknown>>;
  fetchMarkets(): Promise<Record<string, unknown>>;
  fetchOHLCV(req: { symbol: string; timeframe: string; since?: number; limit?: number }): Promise<Array<[number, number, number, number, number, number]>>;
  balances(): Promise<Record<string, unknown>>;
  placeOrder(intent: OrderIntent): Promise<{ orderId: string; raw?: unknown }>;
  fetchOrder?(orderId: string, symbol: string): Promise<{ status?: string; filled?: number; average?: number; fee?: number; raw?: unknown }>;
  fetchOpenOrders?(symbol?: string): Promise<unknown[]>;
  fetchPositions?(): Promise<unknown[]>;
  cancelOrder(req: { orderId: string; symbol: string }): Promise<void>;
}

// Channel adapter interface
export interface ChannelAdapter {
  readonly id: string;
  start(dispatch: (msg: ChannelEnvelope) => Promise<void>): Promise<void>;
  send(msg: { channel: string; target: string; text: string; correlationId?: string }): Promise<void>;
}

// Tool system contracts
export type ToolCategory = "file" | "web" | "execution" | "session" | "memory" | "market" | "browser" | "exec" | "analysis";

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionsRequired?: string[];
  sideEffects?: string[];
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  timeoutMs: number;
  /** Whether this tool can safely run in parallel with other tools. Defaults to false. */
  canRunInParallel?: boolean;
  /** Whether this tool is read-only (safe to cache). Defaults to false. */
  readOnly?: boolean;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
  correlationId?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  truncated: boolean;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolResult>;
}

export interface ToolRegistry {
  register(handler: ToolHandler): void;
  unregister(name: string): boolean;
  get(tool: string): ToolHandler | undefined;
  list(category?: ToolCategory): ToolHandler[];
  execute(call: ToolCall): Promise<ToolResult>;
  /** Execute multiple tool calls. Parallel-safe tools run concurrently; others run sequentially. */
  executeBatch(calls: ToolCall[]): Promise<Array<{ call: ToolCall; result: ToolResult }>>;
  /** Clear cached results. If toolName provided, clears only that tool's cache. */
  clearCache(toolName?: string): void;
  /**
   * Create a restricted view of this registry.
   * The returned registry only exposes tools matching the allow list (if provided)
   * and excludes tools in the deny list. Used for sub-agent scoped tool sets.
   */
  restrict(options: { allow?: string[]; deny?: string[] }): ToolRegistry;
}

/** Convert a ToolDefinition to OpenAI-compatible function-calling format */
export function toolDefToFunction(def: ToolDefinition): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, val] of Object.entries(def.inputSchema)) {
    const isOptional = typeof val === 'string' && val.endsWith('?');
    const typeName = isOptional ? (val as string).slice(0, -1) : val;
    properties[key] = { type: typeName === 'any' ? 'string' : typeName, description: `Parameter ${key}` };
    if (!isOptional) required.push(key);
  }
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
  };
}

// Result types for async operations
export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

export class Ok<T> implements Result<T> {
  constructor(public readonly data: T) {}
  get success(): boolean { return true; }
  get error(): Error | undefined { return undefined; }
}

export class Err<E extends Error> implements Result<never, E> {
  constructor(public readonly error: E) {}
  get success(): boolean { return false; }
  get data(): never | undefined { return undefined; }
}

// Event types for observability
export interface TradeEvent {
  type: "order_placed" | "order_filled" | "order_cancelled" | "position_opened" | "position_closed";
  timestamp: Date;
  data: unknown;
}

export interface RiskEvent {
  type: "risk_check_passed" | "risk_check_failed" | "manual_approval";
  timestamp: Date;
  data: unknown;
}

export interface AgentEvent {
  type: "strategy_proposed" | "order_intents_generated" | "memory_updated" | "skill_execution_completed"
    | "state_change" | "message" | "tool_start" | "tool_end" | "stream_chunk" | "error" | "compact";
  timestamp: Date;
  data: unknown;
}

// Streaming chunk for model responses
export interface ModelStreamChunk {
  type: 'content' | 'tool_call' | 'tool_result' | 'tool_progress' | 'done' | 'error';
  content?: string;
  toolCall?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  };
  toolResult?: {
    toolCallId: string;
    result: ToolResult;
  };
  toolProgress?: {
    toolCallId: string;
    toolName: string;
    status: 'running' | 'completed' | 'error';
    elapsedMs: number;
    message?: string;
  };
  error?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// Agent lifecycle states
export type AgentState = 'idle' | 'starting' | 'running' | 'tool_executing' | 'compacting' | 'stopping' | 'error';

// Conversation message types
export type ConversationMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConversationMessage {
  role: ConversationMessageRole;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  timestamp: Date;
}

// Chat response from the agent
export interface ChatResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: ToolResult;
    durationMs: number;
  }>;
  state: AgentState;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
  compacted: boolean;
  metadata?: Record<string, unknown>;
}

// Execution types
export type ExecutionMode = "backtest" | "paper" | "shadow" | "micro_live" | "live";

export interface ExecutionResult {
  orderId: string;
  status: "filled" | "rejected" | "pending" | "pending_approval";
  trade?: {
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    value: number;
    fees: number;
  };
  rejectionReason?: string;
  approvalTokenId?: string;
  timestamp: Date;
}

export interface ExecutionRouter {
  execute(intent: OrderIntent): Promise<ExecutionResult>;
  getStatus(orderId: string): Promise<ExecutionResult | null>;
  cancel(orderId: string, symbol: string): Promise<void>;
}

// Approval types
export interface ApprovalToken {
  id: string;
  approvalRequestId: string;
  approvedBy: string;
  channel: string;
  action: string;
  artifactType: string;
  artifactHash: string;
  createdAt: Date;
  expiresAt: Date;
  singleUse: boolean;
  used: boolean;
  signature: string;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  artifactType: string;
  artifactId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requestedBy: string;
  requiredApprovals: string[];
  createdAt: Date;
  expiresAt: Date;
  summary: string;
  status: "pending" | "approved" | "rejected" | "expired";
  policyDecisionId?: string;
  riskDecisionId?: string;
  context?: Record<string, unknown>;
}

export interface ApprovalEngine {
  createRequest(request: Omit<ApprovalRequest, "id" | "createdAt" | "status">): Promise<string>;
  getRequest(id: string): Promise<ApprovalRequest | null>;
  approve(id: string, approver: string, channel: string, context?: Record<string, unknown>): Promise<ApprovalToken>;
  reject(id: string, approver: string, reason: string): Promise<void>;
  verifyToken(token: ApprovalToken, action: string, artifactHash?: string): Promise<boolean>;
  useToken(tokenId: string): Promise<void>;
  getPendingRequests(): Promise<ApprovalRequest[]>;
}

// Model provider contracts
export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  contextWindow?: number;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string[];
  tools?: ToolDefinition[];
  /** Runtime-only cancellation signal. Never serialized into provider payloads. */
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: string;
  reasoningContent?: string;
  model: string;
  provider: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  call(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
  getContextWindowTokens?(model?: string): number | undefined;
}

export interface ModelRouter {
  selectProvider(task: string, riskLevel?: string): Promise<ModelProvider>;
  call(request: ModelRequest, task?: string): Promise<ModelResponse>;
  stream(request: ModelRequest, task?: string): AsyncIterable<ModelStreamChunk>;
  getProvider(id: string): ModelProvider | undefined;
  getCostStats(): Promise<{ totalCost: number; totalTokens: number; callsByProvider: Record<string, number> }>;
  switchModel?(modelId: string): { switched: boolean; previousModel: string; newModel: string };
  getActiveModel?(): string;
  getContextWindowTokens?(modelId?: string): number | undefined;
  listModels?(): Array<{ id: string; provider: string; supportsStreaming: boolean }>;
  resetModel?(): void;
}

// ---- Compression Types (Headroom Cannibalization) ----

export enum ContentType {
  CODE = 'code',
  JSON = 'json',
  DIFF = 'diff',
  LOG = 'log',
  PLAINTEXT = 'plaintext',
  SEARCH_RESULT = 'search_result',
  ERROR = 'error',
  UNKNOWN = 'unknown',
}

export interface ContentRoute {
  contentType: ContentType;
  confidence: number;
  detectedBy: string;
  subType?: string;
}

export interface CompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  manifest: CompressionManifestEntry[];
  ccrs: CCRMarker[];
}

export interface CompressionManifestEntry {
  originalOffset: number;
  compressedOffset: number;
  originalLength: number;
  compressedLength: number;
  action: 'preserved' | 'truncated' | 'summarized' | 'ccr_replaced' | 'removed';
  contentType: ContentType;
  reason?: string;
}

export interface CCRMarker {
  key: string;
  originalLength: number;
  replacedLength: number;
  storedAt: Date;
}

export interface LiveZoneConfig {
  maxLiveTokens: number;
  maxToolOutputTokens: number;
  compressionThreshold: number;
  preserveStructure: boolean;
}

export interface CacheAlignment {
  normalizedPrefix: string;
  cacheKey: string;
  volatileContentDetected: boolean;
  breakpoints: CacheBreakpoint[];
}

export interface CacheBreakpoint {
  index: number;
  type: 'tools' | 'system' | 'ephemeral';
  reason: string;
}

export interface SharedContext {
  agentId: string;
  sessionId: string;
  sharedTokens: { key: string; value: string }[];
  ccrStore?: CCRMarker[];
  lastAccess: Date;
}
