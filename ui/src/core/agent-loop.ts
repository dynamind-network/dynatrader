/**
 * AgentLoop — terminal harness bridge for the DynaTrader runtime SDK
 *
 * This file belongs to the terminal/TUI harness. It keeps the Claude Code-style
 * shell experience local, while delegating agent execution, tool orchestration,
 * and model/runtime behavior to DynaTrader over JSON-RPC.
 *
 * The public API is unchanged, so all existing consumers (useAgentBootstrap,
 * CommandService, useStatusPolling, etc.) continue to work.
 */

import { JsonRpcClient } from '../rpc/client.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type {
  AgentConfig,
  AgentEvent,
  ExecutionMode,
  ApprovalMode,
  ToolExecutionContext,
  ToolResult,
  ToolExecutionRecord,
  RecoveryState,
} from './types.js';
import type { EffortLevel } from './providers/catalog.js';
import { AgentState } from './agent-state.js';
import type { Plan } from './plan-manager.js';
import { resolveDynatraderLaunchSpec } from './dynatrader-launcher.js';
import { SessionCheckpoint } from './session-checkpoint.js';

interface RpcClientLike {
  call<T>(method: string, params?: unknown): Promise<T>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
  close(): void;
}

// Re-export AgentState for backward compatibility
export { AgentState };

// DynaTrader RPC method names
const RPC = {
  PROMPT_SUBMIT: 'prompt.submit',
  PROMPT_CANCEL: 'prompt.cancel',
  CONVERSATION_COMPACT: 'conversation.compact',
  TOOL_LIST: 'tool.list',
  AGENT_DELEGATE: 'agent.delegate',
  AGENT_DELEGATE_START: 'agent.delegate.start',
  AGENT_DELEGATE_CANCEL: 'agent.delegate.cancel',
  AGENT_DELEGATE_LIST: 'agent.delegate.list',
  TOOL_POLICY_SET: 'tool.policy.set',
  APPROVAL_RESOLVE: 'approval.resolve',
  MODEL_SWITCH: 'model.switch',
  MODEL_LIST: 'model.list',
  MODEL_ACTIVE: 'model.active',
  SESSION_CREATE: 'session.create',
  SESSION_HISTORY: 'session.history',
  SESSION_LIST: 'session.list',
  SESSION_SET_PERSONA: 'session.set_persona',
  AGENT_STATE: 'agent.state',
  PLAN_ENTER: 'plan.enter',
  PLAN_EXIT: 'plan.exit',
  PLAN_APPROVE: 'plan.approve',
  PLAN_REJECT: 'plan.reject',
} as const;

// DynaTrader RPC event names
const EVENTS = {
  MESSAGE_DELTA: 'message.delta',
  TOOL_START: 'tool.start',
  TOOL_COMPLETE: 'tool.complete',
  APPROVAL_REQUEST: 'approval.request',
  THINKING: 'thinking',
  ERROR: 'error',
  SESSION_UPDATE: 'session.update',
  PLAN_MODE_ENTERED: 'plan.mode.entered',
  PLAN_MODE_EXITED: 'plan.mode.exited',
  PLAN_STEP_UPDATE: 'plan.step.update',
  AGENT_TASK_UPDATE: 'agent.task.update',
} as const;

// ---------------------------------------------------------------------------
// Session stats (lightweight local tracking)
// ---------------------------------------------------------------------------

export interface SessionStats {
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  totalDurationMs: number;
  loopWarnings: number;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private client: RpcClientLike;
  private config: AgentConfig;
  private onEvent?: (event: AgentEvent) => void;
  private onApprovalRequired?: (
    toolName: string,
    input: Record<string, unknown>,
    reason?: string
  ) => Promise<boolean>;
  private onPlanApprovalRequired?: (plan: Plan) => Promise<boolean>;
  private _currentPlan: Plan | null = null;
  private _planningMode = false;

  // Local state
  private _executionMode: ExecutionMode = 'normal';
  private _approvalMode: ApprovalMode = 'default';
  private _state: AgentState = AgentState.IDLE;
  private _currentModel: string;
  private _effort: EffortLevel = 'none';
  private _conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private _stats: SessionStats = {
    totalToolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    totalDurationMs: 0,
    loopWarnings: 0,
  };

  // Streaming accumulator
  private _streamingText = '';
  private _activeRun: {
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  } | null = null;

  // Tool execution tracking
  private _toolLedger: ToolExecutionRecord[] = [];
  private _pendingToolExecutions: Map<string, { name: string; input: unknown; startedAt: number }> =
    new Map();
  private _lastToolSignature: string | null = null;
  private _lastToolSignatureRepeatCount = 0;
  private _loopWarningEmitted = false;

  // Session checkpoint for crash recovery
  private _checkpoint: SessionCheckpoint | null = null;
  private _currentSessionId: string | null = null;

  // Auto-checkpoint callback (set externally by App)
  private _autoCheckpoint: ((label: string) => void) | null = null;

  constructor(
    apiKeys: Record<string, string>,
    config: AgentConfig,
    _toolRegistry: ToolRegistry | undefined,
    options?: {
      onEvent?: (event: AgentEvent) => void;
      onApprovalRequired?: (
        toolName: string,
        input: Record<string, unknown>,
        reason?: string
      ) => Promise<boolean>;
      onPlanApprovalRequired?: (plan: Plan) => Promise<boolean>;
      rpcClient?: RpcClientLike;
    }
  ) {
    this.config = { ...config };
    this._currentModel = config.model;
    this.onEvent = options?.onEvent;
    this.onApprovalRequired = options?.onApprovalRequired;
    this.onPlanApprovalRequired = options?.onPlanApprovalRequired;

    // Spawn the DynaTrader runtime SDK. Prefer a repo-local smart entrypoint when
    // the installed binary is unavailable so dev setups do not fail with ENOENT.
    const launchSpec = resolveDynatraderLaunchSpec();
    this.client = options?.rpcClient ?? new JsonRpcClient(launchSpec.command, launchSpec.args);
    this.wireEvents();
  }

  // -------------------------------------------------------------------------
  // Event bridging (DynaTrader notifications -> AgentEvent)
  // -------------------------------------------------------------------------

  private wireEvents(): void {
    this.client.on('transport.error', (value) => {
      const error = value instanceof Error ? value : new Error(String(value));
      this._state = AgentState.ERROR;
      this.emit({
        type: 'error',
        error: `Unable to start DynaTrader runtime SDK: ${error.message}. Tried the repo entrypoint first, then the dynatrader binary.`,
      });
    });
    this.client.on(EVENTS.MESSAGE_DELTA, (params) => {
      const { content } = params as { content: string; sessionId?: string };
      this._streamingText += content;
      this.emit({ type: 'partial', content });
    });

    this.client.on(EVENTS.TOOL_START, (params) => {
      const { toolName, args, toolCallId } = params as {
        toolName: string;
        args: Record<string, unknown>;
        toolCallId: string;
      };
      const startedAt = Date.now();
      this._pendingToolExecutions.set(toolCallId, { name: toolName, input: args, startedAt });
      this._stats.totalToolCalls++;
      this.trackToolLoop(toolName, args);
      this.emit({ type: 'tool_start', toolName, input: args });

      // Auto-checkpoint before file-modifying tool calls
      if (this._autoCheckpoint && (toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit')) {
        const filePath = (args.file_path ?? args.filePath ?? args.path ?? 'unknown') as string;
        this._autoCheckpoint(`before-${toolName}:${filePath}`);
      }
    });

    this.client.on(EVENTS.TOOL_COMPLETE, (params) => {
      const { toolCallId, toolName, result, durationMs, success, error } = params as {
        toolCallId: string;
        toolName: string;
        result: unknown;
        durationMs: number;
        success?: boolean;
        error?: string;
      };
      const pending = this._pendingToolExecutions.get(toolCallId);
      if (pending) {
        if (success === false) this._stats.failedToolCalls++;
        else this._stats.successfulToolCalls++;
        const toolResult: ToolResult = {
          success: success !== false,
          output:
            typeof result === 'string'
              ? result
              : result === undefined
                ? (error ?? '')
                : JSON.stringify(result),
          summary: error ?? '',
        };
        const record: ToolExecutionRecord = {
          toolName: pending.name,
          input: pending.input as Record<string, unknown>,
          result: toolResult,
          startedAt: pending.startedAt,
          finishedAt: Date.now(),
          durationMs: durationMs || Date.now() - pending.startedAt,
          approvalRequired: false,
          approved: true,
          parallelizable: false,
          status: success === false ? 'error' : 'success',
          signature: pending.name,
        };
        this._toolLedger.push(record);
        this._pendingToolExecutions.delete(toolCallId);
        this.emit({ type: 'tool_end', toolName: pending.name, result: toolResult });
      }
    });

    this.client.on(EVENTS.APPROVAL_REQUEST, (params) => {
      const { requestId, action, summary } = params as {
        requestId: string;
        action: string;
        summary: string;
      };
      const toolName = action;
      const input: Record<string, unknown> = {};
      this.emit({ type: 'approval_request', toolName, input, reason: summary });
      const decision = this.onApprovalRequired
        ? this.onApprovalRequired(toolName, input, summary)
        : Promise.resolve(false);
      void decision
        .then((approved) => this.client.call(RPC.APPROVAL_RESOLVE, { requestId, approved }))
        .catch(() =>
          this.client.call(RPC.APPROVAL_RESOLVE, { requestId, approved: false }).catch(() => {})
        );
    });

    this.client.on(EVENTS.THINKING, (params) => {
      const { content } = params as { content: string };
      this.emit({ type: 'thinking', content });
    });

    this.client.on(EVENTS.ERROR, (params) => {
      const { message } = params as { message: string };
      this.emit({ type: 'error', error: message });
    });

    this.client.on(EVENTS.PLAN_MODE_ENTERED, (params) => {
      const { goal } = (params ?? {}) as { goal?: string };
      this._planningMode = true;
      this.emit({ type: 'plan_mode_entered', goal });
    });

    this.client.on(EVENTS.PLAN_MODE_EXITED, (params) => {
      const { plan, approved } = (params ?? {}) as { plan?: Plan; approved?: boolean };
      if (plan) this._currentPlan = this.hydratePlan(plan);
      this.emit({ type: 'plan_mode_exited', plan: this._currentPlan ?? undefined, approved });
      if (this._currentPlan && approved === undefined && this.onPlanApprovalRequired) {
        void this.onPlanApprovalRequired(this._currentPlan).then((ok) =>
          ok ? this.approveCurrentPlan() : this.rejectCurrentPlan()
        );
      }
      if (approved) this._planningMode = false;
    });

    this.client.on(EVENTS.PLAN_STEP_UPDATE, (params) => {
      const { planId, step, status } = params as {
        planId: string;
        step: Plan['steps'][number] | string;
        status?: Plan['steps'][number]['status'];
      };
      const normalizedStep: Plan['steps'][number] =
        typeof step === 'string'
          ? {
              id: step,
              description: step.replace(/_/g, ' '),
              reasoning: 'Planning lifecycle update from DynaTrader.',
              status: status ?? 'in_progress',
            }
          : step;
      const existing = this._currentPlan?.steps.find((item) => item.id === normalizedStep.id);
      if (existing) Object.assign(existing, normalizedStep);
      this.emit({ type: 'plan_step_update', planId, step: normalizedStep });
    });

    this.client.on(EVENTS.AGENT_TASK_UPDATE, (params) => {
      const { task } = params as {
        task: {
          taskId: string;
          agent: string;
          status: 'running' | 'completed' | 'failed' | 'cancelled';
          result?: unknown;
          error?: string;
        };
      };
      const detail =
        task.status === 'completed'
          ? typeof task.result === 'string'
            ? task.result
            : JSON.stringify(task.result, null, 2)
          : task.error;
      this.emit({
        type: 'text',
        content: `@${task.agent} [${task.taskId}] ${task.status}${detail ? `:\n\n${detail}` : ''}`,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Session checkpoint (Phase 1B — crash recovery)
  // -------------------------------------------------------------------------

  async initializeCheckpoint(sessionId: string): Promise<void> {
    this._currentSessionId = sessionId;
    this._checkpoint = new SessionCheckpoint(sessionId);
    await this._checkpoint.initialize();
  }

  getCheckpoint(): SessionCheckpoint | null {
    return this._checkpoint;
  }

  async resumeFromCheckpoint(): Promise<{
    conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
    state: unknown;
    turnCount: number;
  } | null> {
    if (!this._checkpoint) return null;
    const result = await this._checkpoint.resume();
    for (const msg of result.conversation) {
      this._conversation.push(msg);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Core API (matches old AgentLoop public interface)
  // -------------------------------------------------------------------------

  async run(userMessage: string, context: ToolExecutionContext): Promise<string> {
    this._state = AgentState.RUNNING;
    this._streamingText = '';
    this._lastToolSignature = null;
    this._lastToolSignatureRepeatCount = 0;
    this._loopWarningEmitted = false;
    this.emit({ type: 'text', content: '' });

    // Track user message in conversation
    this._conversation.push({ role: 'user', content: userMessage });

    // Write user turn to checkpoint
    if (this._checkpoint) {
      await this._checkpoint.appendTurn({ userMessage });
    }

    const startTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      this._activeRun = { resolve, reject };

      this.client
        .call<{
          content: string;
          state: string;
          usage: { promptTokens: number; completionTokens: number; totalTokens: number };
          durationMs: number;
          compacted: boolean;
        }>(RPC.PROMPT_SUBMIT, {
          message: userMessage,
          sessionId: context.conversationId,
          reasoningEffort: this._effort !== 'none' ? this._effort : undefined,
        })
        .then(async (result) => {
          this._stats.totalDurationMs += Date.now() - startTime;
          this._conversation.push({ role: 'assistant', content: result.content });

          // Write assistant response to checkpoint
          if (this._checkpoint) {
            const toolCalls = this._toolLedger
              .slice(-20)
              .map((r) => ({
                name: r.toolName,
                input: r.input,
                result: r.result?.output,
                success: r.status === 'success',
                durationMs: r.durationMs,
              }));

            await this._checkpoint.appendTurn({
              assistantResponse: result.content,
              toolCalls,
              tokenUsage: result.usage,
            });

            await this._checkpoint.saveState({
              lastTurnAt: Date.now(),
            });
          }

          this._state = AgentState.IDLE;
          this.emit({ type: 'done', finalResponse: result.content });

          this._activeRun = null;
          resolve(result.content);
        })
        .catch((error) => {
          this._state = AgentState.IDLE;
          const errorMessage = error?.message || String(error);
          this.emit({ type: 'error', error: errorMessage });
          this._activeRun = null;
          reject(new Error(errorMessage));
        });
    });
  }

  stop(): void {
    if (this._state === AgentState.RUNNING || this._state === AgentState.STARTING) {
      this._state = AgentState.STOPPING;
      this.client.call(RPC.PROMPT_CANCEL).catch(() => {});
      setTimeout(() => {
        if (this._state === AgentState.STOPPING) {
          this._state = AgentState.IDLE;
        }
        if (this._activeRun) {
          this._activeRun.resolve('Request interrupted.');
          this._activeRun = null;
        }
      }, 200);
    }
  }

  handleEscapeKey(): void {
    this.stop();
    this.emit({ type: 'plan_interrupted', reason: 'esc_pressed' });
  }

  // -------------------------------------------------------------------------
  // Auto-checkpoint & Steer injection
  // -------------------------------------------------------------------------

  setAutoCheckpoint(callback: (label: string) => void): void {
    this._autoCheckpoint = callback;
  }

  injectInstruction(text: string): void {
    this._conversation.push({ role: 'user', content: `[Steer] ${text}` });
    this.emit({ type: 'text', content: `[Steer instruction injected: ${text}]` });
  }

  // -------------------------------------------------------------------------
  // Model management
  // -------------------------------------------------------------------------

  switchModel(modelId: string): { success: boolean; error?: string } {
    this.client
      .call<{ switched: boolean; newModel: string }>(RPC.MODEL_SWITCH, { modelId })
      .then((result) => {
        if (result.switched) {
          this._currentModel = result.newModel;
          this.emit({ type: 'text', content: `Model switched to ${result.newModel}` });
        }
      })
      .catch((error) => {
        this.emit({ type: 'error', error: `Model switch failed: ${error?.message || error}` });
      });

    // Optimistic return — the actual switch is async via RPC
    this._currentModel = modelId;
    return { success: true };
  }

  getCurrentModel(): { provider: string; model: string } {
    return { provider: 'dynatrader', model: this._currentModel };
  }

  // -------------------------------------------------------------------------
  // Execution mode
  // -------------------------------------------------------------------------

  setExecutionMode(mode: ExecutionMode): void {
    this._executionMode = mode;
    this._approvalMode = mode === 'auto-approve' ? 'yolo' : 'default';
    this.emit({ type: 'mode_changed', mode });
  }

  setEffort(effort: EffortLevel): void {
    this._effort = effort;
  }

  getEffort(): EffortLevel {
    return this._effort;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this._approvalMode = mode;
  }

  getApprovalMode(): ApprovalMode {
    return this._approvalMode;
  }

  getExecutionMode(): ExecutionMode {
    return this._executionMode;
  }

  // -------------------------------------------------------------------------
  // Conversation management
  // -------------------------------------------------------------------------

  getConversation(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [...this._conversation];
  }

  clearConversation(): void {
    this._conversation = [];
    this._toolLedger = [];
    this._pendingToolExecutions.clear();
    this._lastToolSignature = null;
    this._lastToolSignatureRepeatCount = 0;
    this._loopWarningEmitted = false;
    this._stats = {
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      totalDurationMs: 0,
      loopWarnings: 0,
    };
  }

  close(): void {
    this.client.close();
  }

  addMessage(message: { role: string; content: string | unknown[] }): void {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    let content: string;
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .filter((b): b is { type: 'text'; text: string } => {
          return (
            typeof b === 'object' &&
            b !== null &&
            'type' in b &&
            (b as { type: string }).type === 'text'
          );
        })
        .map((b) => (b as { text?: string }).text || '')
        .join('');
    } else {
      content = '';
    }
    this._conversation.push({ role, content });
  }

  // -------------------------------------------------------------------------
  // Tool execution ledger & stats
  // -------------------------------------------------------------------------

  getToolExecutionLedger(): ToolExecutionRecord[] {
    return [...this._toolLedger];
  }

  getSessionStats(): SessionStats {
    return { ...this._stats };
  }

  // -------------------------------------------------------------------------
  // Token estimation (lightweight local estimate)
  // -------------------------------------------------------------------------

  estimateTokens(): number {
    // Rough estimate: ~4 chars per token
    let totalChars = 0;
    for (const msg of this._conversation) {
      totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / 4);
  }

  // -------------------------------------------------------------------------
  // Compaction (delegated to DynaTrader)
  // -------------------------------------------------------------------------

  async compact(): Promise<{ success: boolean; message: string }> {
    if (this._state === AgentState.RUNNING || this._state === AgentState.STARTING) {
      return { success: false, message: 'Cannot compact while agent is running.' };
    }
    const result = await this.client.call<{
      compacted: boolean;
      message: string;
      messageCount: number;
    }>(RPC.CONVERSATION_COMPACT);
    return { success: true, message: result.message };
  }

  async listAvailableTools(): Promise<
    Array<{
      name: string;
      description: string;
      category: string;
      readOnly?: boolean;
      riskLevel?: string;
    }>
  > {
    const result = await this.client.call<{
      tools: Array<{
        name: string;
        description: string;
        category: string;
        readOnly?: boolean;
        riskLevel?: string;
      }>;
    }>(RPC.TOOL_LIST);
    return result.tools;
  }

  async delegateTask(
    agent: string,
    task: string,
    context?: Record<string, unknown>
  ): Promise<unknown> {
    const result = await this.client.call<{ agent?: string; result: unknown }>(RPC.AGENT_DELEGATE, {
      agent,
      task,
      context,
    });
    return result.result;
  }

  async startDelegatedTask(
    agent: string,
    task: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    const result = await this.client.call<{ task: { taskId: string } }>(RPC.AGENT_DELEGATE_START, {
      agent,
      task,
      context,
    });
    return result.task.taskId;
  }

  async cancelDelegatedTask(taskId: string): Promise<boolean> {
    const result = await this.client.call<{ cancelled: boolean }>(RPC.AGENT_DELEGATE_CANCEL, {
      taskId,
    });
    return result.cancelled;
  }

  async listDelegatedTasks(): Promise<
    Array<{ taskId: string; agent: string; task: string; status: string; createdAt: string }>
  > {
    const result = await this.client.call<{
      tasks: Array<{
        taskId: string;
        agent: string;
        task: string;
        status: string;
        createdAt: string;
      }>;
    }>(RPC.AGENT_DELEGATE_LIST);
    return result.tasks;
  }

  async configureToolPolicy(
    allowedTools?: string[],
    disallowedTools?: string[]
  ): Promise<string[]> {
    const result = await this.client.call<{ configured: true; availableTools: string[] }>(
      RPC.TOOL_POLICY_SET,
      {
        allowedTools,
        disallowedTools,
      }
    );
    return result.availableTools;
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  getCurrentPlan(): Plan | null {
    return this._currentPlan;
  }

  async approveCurrentPlan(): Promise<boolean> {
    if (!this._currentPlan) return false;
    const result = await this.client.call<{ approved?: boolean } | boolean>(RPC.PLAN_APPROVE, {
      planId: this._currentPlan.id,
    });
    const approved = typeof result === 'boolean' ? result : result.approved !== false;
    if (approved) {
      this._currentPlan.status = 'approved';
      this._planningMode = false;
    }
    return approved;
  }

  rejectCurrentPlan(reason?: string): Promise<boolean> {
    if (!this._currentPlan) return Promise.resolve(false);
    return this.client.call(RPC.PLAN_REJECT, { planId: this._currentPlan.id, reason }).then(() => {
      if (this._currentPlan) this._currentPlan.status = 'draft';
      this._planningMode = true;
      return true;
    });
  }

  cancelCurrentPlan(reason?: string): void {
    void this.rejectCurrentPlan(reason);
  }

  async setPlanningMode(enabled: boolean, goal?: string): Promise<void> {
    await this.client.call(enabled ? RPC.PLAN_ENTER : RPC.PLAN_EXIT, goal ? { goal } : undefined);
    this._planningMode = enabled;
  }

  isPlanningMode(): boolean {
    return this._planningMode;
  }

  private hydratePlan(plan: Plan): Plan {
    return {
      ...plan,
      createdAt: new Date(plan.createdAt),
      updatedAt: plan.updatedAt ? new Date(plan.updatedAt) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Recovery (stub — DynaTrader handles recovery internally)
  // -------------------------------------------------------------------------

  getRecoveryState(): RecoveryState {
    return {
      consecutiveFailures: 0,
      lastFailureReason: null,
      fallbackModelAttempted: false,
      outputTokenEscalationCount: 0,
      compactAttempted: false,
      softResetAttempted: false,
      failuresThisTurn: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt building (stub — DynaTrader builds prompts internally)
  // -------------------------------------------------------------------------

  async buildModularSystemPrompt(
    _toolDefinitions: Array<{ name: string; description: string }>
  ): Promise<string> {
    return 'System prompt managed by DynaTrader.';
  }

  invalidatePromptCache(): void {
    // No-op — DynaTrader manages its own prompt cache
  }

  getPromptCacheStats(): { cached: number; total: number } {
    return { cached: 0, total: 0 };
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get running(): boolean {
    return this._state === AgentState.RUNNING || this._state === AgentState.STARTING;
  }

  get currentState(): AgentState {
    return this._state;
  }

  get turns(): number {
    // DynaTrader manages turns internally; return 0 for backward compat
    return 0;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  private serializeToolInput(input: Record<string, unknown>): string {
    const sortValue = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map((item) => sortValue(item));
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        );
        return Object.fromEntries(entries.map(([key, val]) => [key, sortValue(val)]));
      }
      return value;
    };

    return JSON.stringify(sortValue(input));
  }

  private trackToolLoop(toolName: string, input: Record<string, unknown>): void {
    const signature = `${toolName}:${this.serializeToolInput(input)}`;

    if (signature === this._lastToolSignature) {
      this._lastToolSignatureRepeatCount += 1;
    } else {
      this._lastToolSignature = signature;
      this._lastToolSignatureRepeatCount = 1;
      this._loopWarningEmitted = false;
      return;
    }

    if (!this._loopWarningEmitted && this._lastToolSignatureRepeatCount >= 2) {
      this._loopWarningEmitted = true;
      this._stats.loopWarnings += 1;
      const message = `Repeated tool call detected for ${toolName}. The same input has been requested ${this._lastToolSignatureRepeatCount} times.`;
      this.emit({
        type: 'loop_warning',
        message,
        repeatedSignatures: [signature],
      });
      this.emit({
        type: 'text',
        content: `⚠ ${message}`,
      });
    }
  }
}
