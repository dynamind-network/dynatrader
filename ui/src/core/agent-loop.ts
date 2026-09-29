/**
 * AgentLoop — terminal harness bridge for the DynaTrader runtime SDK
 *
 * This file belongs to the terminal/TUI harness. It keeps the interactive shell
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
import { findProviderForModel } from './providers/index.js';
import { AgentState } from './agent-state.js';
import { resolveDynatraderLaunchSpec } from './dynatrader-launcher.js';
import { SessionCheckpoint } from './session-checkpoint.js';
import { EnhancedHookLoader, loadHookConfig } from '../services/hook-loader.js';

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
  PROMPT_APPROVAL_MODE_SET: 'prompt.approval_mode.set',
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
  AGENT_TASK_UPDATE: 'agent.task.update',
  AGENT_ACTIVITY: 'agent.activity',
} as const;

function formatToolOutput(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return String(result ?? '');

  const value = result as Record<string, unknown>;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.files)) return value.files.map(String).join('\n');
  if (toolName === 'write' && typeof value.path === 'string') {
    return `Wrote ${value.path}${typeof value.bytesWritten === 'number' ? ` (${value.bytesWritten} bytes)` : ''}`;
  }
  if (toolName === 'edit' && typeof value.filePath === 'string') {
    return `Updated ${value.filePath}${typeof value.replacements === 'number' ? ` (${value.replacements} replacement${value.replacements === 1 ? '' : 's'})` : ''}`;
  }
  return JSON.stringify(value, null, 2);
}

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
  private _childTextBuffers = new Map<string, string>();
  private _pendingApprovalTools = new Map<string, string>();
  private _hookLoaderPromise: Promise<EnhancedHookLoader> | null = null;
  private _sessionHooksStarted = false;

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
      rpcClient?: RpcClientLike;
    }
  ) {
    this.config = { ...config };
    this._currentModel = config.model;
    this.onEvent = options?.onEvent;
    this.onApprovalRequired = options?.onApprovalRequired;

    // Prefer a repo-local entrypoint when the installed binary is unavailable.
    const launchSpec = resolveDynatraderLaunchSpec({
      noDaemon: process.env.DYNATRADER_NO_DAEMON === 'true',
    });
    const providerEnv: NodeJS.ProcessEnv = {};
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (!key?.trim()) continue;
      const envName = provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : provider === 'lmstudio'
          ? 'LM_STUDIO_API_KEY'
          : `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
      providerEnv[envName] = key;
      if (provider === 'google') providerEnv.GEMINI_API_KEY ??= key;
    }
    this.client = options?.rpcClient ?? new JsonRpcClient(launchSpec.command, launchSpec.args, providerEnv);
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
        const rawResult =
          result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
        const toolSucceeded = success ?? (rawResult?.success as boolean | undefined) ?? true;
        if (toolSucceeded) this._stats.successfulToolCalls++;
        else this._stats.failedToolCalls++;
        const data = rawResult?.data;
        const outputValue = rawResult?.output ?? rawResult?.stdout ?? data;
        const output =
          outputValue !== undefined
            ? formatToolOutput(pending.name, outputValue)
            : typeof result === 'string'
              ? result
              : result !== undefined && !rawResult?.error && !rawResult?.stderr
                ? formatToolOutput(pending.name, result)
                : (rawResult?.stderr as string | undefined) ??
                  (rawResult?.error as string | undefined) ??
                  error ??
                  (success === false ? 'Tool failed without an error message.' : 'Completed successfully.');
        const errorText =
          (rawResult?.error as string | undefined) ??
          (rawResult?.stderr as string | undefined) ??
          error;
        const toolResult: ToolResult = {
          success: toolSucceeded,
          output,
          summary: errorText ?? '',
          artifacts: rawResult?.artifacts as Record<string, unknown> | undefined,
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
          status: toolSucceeded ? 'success' : 'error',
          signature: pending.name,
        };
        this._toolLedger.push(record);
        this._pendingToolExecutions.delete(toolCallId);
        this.emit({ type: 'tool_end', toolName: pending.name, result: toolResult });
        void this.getHookLoader().then((loader) => toolSucceeded
          ? loader.executePostToolHook(pending.name, pending.input as Record<string, unknown>, rawResult ?? {}, { sessionId: this._currentSessionId ?? 'default' })
          : loader.executePostToolFailureHook(pending.name, pending.input as Record<string, unknown>, rawResult ?? {}, { sessionId: this._currentSessionId ?? 'default' }))
          .catch((error) => console.warn('Tool lifecycle hook failed:', error));
      }
    });

    this.client.on(EVENTS.APPROVAL_REQUEST, (params) => {
      const { requestId, action, summary } = params as {
        requestId: string;
        action: string;
        summary: string;
        input?: Record<string, unknown>;
      };
      const toolName = action;
      const input: Record<string, unknown> = (params as { input?: Record<string, unknown> }).input ?? {};
      this._pendingApprovalTools.set(requestId, toolName);
      this.emit({ type: 'approval_request', toolName, input, reason: summary });
      const decision = this.onApprovalRequired
        ? this.onApprovalRequired(toolName, input, summary)
        : Promise.resolve(false);
      void decision
        .then((approved) => this.client.call(RPC.APPROVAL_RESOLVE, { requestId, approved }))
        .finally(() => this._pendingApprovalTools.delete(requestId))
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

    this.client.on(EVENTS.AGENT_ACTIVITY, (params) => {
      const { agent, taskId, chunk } = params as {
        agent: string;
        taskId: string;
        chunk: { type: string; content?: string; error?: string; toolCall?: { function?: { name?: string; arguments?: string } }; toolResult?: { toolCallId?: string; result?: unknown }; toolProgress?: { toolName?: string; status?: string } };
      };
      const key = `${agent}:${taskId}`;
      const flushChildText = (): void => {
        const text = this._childTextBuffers.get(key)?.trim();
        this._childTextBuffers.delete(key);
        if (text) this.emit({ type: 'text', content: `↳ ${agent} [${taskId}] ${text}` });
      };
      if (chunk.type === 'content') {
        this._childTextBuffers.set(key, (this._childTextBuffers.get(key) ?? '') + (chunk.content ?? ''));
        return;
      }
      flushChildText();
      let detail = '';
      if (chunk.type === 'tool_call') {
        const fn = chunk.toolCall?.function;
        detail = `calling ${fn?.name ?? 'tool'}${fn?.arguments ? ` ${fn.arguments.slice(0, 600)}` : ''}`;
      } else if (chunk.type === 'tool_progress') {
        detail = `${chunk.toolProgress?.status ?? 'running'} ${chunk.toolProgress?.toolName ?? 'tool'}`;
      } else if (chunk.type === 'tool_result') {
        const result = chunk.toolResult?.result;
        detail = `tool result ${JSON.stringify(result ?? {}).slice(0, 1200)}`;
      } else if (chunk.type === 'error') detail = `error ${chunk.error ?? chunk.content ?? ''}`;
      if (detail) this.emit({ type: 'text', content: `↳ ${agent} [${taskId}] ${detail}` });
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
    this._currentSessionId = context.conversationId;
    try {
      const hooks = await this.getHookLoader();
      if (!this._sessionHooksStarted) {
        await hooks.executeSessionStartHooks({ sessionId: context.conversationId, cwd: context.workingDirectory });
        this._sessionHooksStarted = true;
      }
    } catch (error) {
      console.warn('Session start hook setup failed:', error);
    }

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
          approvalMode: this._approvalMode,
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

          let hooksPassed = 0;
          let hooksFailed = 0;
          try {
            const hooks = await this.getHookLoader();
            const stopHookCount = hooks.listHooks().filter((hook) => hook.event === 'Stop').length;
            const results = await hooks.executeStopHooks({ sessionId: context.conversationId, cwd: context.workingDirectory });
            hooksPassed = results.filter((item) => item.outcome === 'success').length;
            hooksFailed = Math.max(0, stopHookCount - hooksPassed);
          } catch (error) {
            hooksFailed++;
            console.warn('Post-turn hook failed:', error);
          }
          this.emit({ type: 'turn_end', durationMs: Date.now() - startTime, hooksPassed, hooksFailed });

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

  private getHookLoader(): Promise<EnhancedHookLoader> {
    if (!this._hookLoaderPromise) {
      this._hookLoaderPromise = loadHookConfig().then((config) => new EnhancedHookLoader(config));
    }
    return this._hookLoaderPromise;
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
    const providerModelId = modelId.includes('/')
      ? modelId
      : `${findProviderForModel(modelId) ?? ''}/${modelId}`;
    this.client
      .call<{ switched: boolean; newModel: string }>(RPC.MODEL_SWITCH, { modelId: providerModelId })
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
    if (this._approvalMode === 'yolo') {
      for (const toolName of this._pendingApprovalTools.values()) {
        this.emit({ type: 'approval_auto_resolved', toolName });
      }
    }
    this.client.call(RPC.PROMPT_APPROVAL_MODE_SET, { approvalMode: this._approvalMode }).catch((error) => {
      this.emit({ type: 'error', error: `Could not update tool approval mode: ${error instanceof Error ? error.message : String(error)}` });
    });
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

  async endSession(): Promise<void> {
    try {
      const hooks = await this.getHookLoader();
      await hooks.executeSessionEndHooks({ sessionId: this._currentSessionId ?? 'default' });
    } catch (error) {
      console.warn('Session end hook failed:', error);
    }
    this._sessionHooksStarted = false;
  }

  close(): void {
    void this.endSession();
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

  async setPlanningMode(enabled: boolean, goal?: string): Promise<void> {
    await this.client.call(enabled ? RPC.PLAN_ENTER : RPC.PLAN_EXIT, goal ? { goal } : undefined);
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
