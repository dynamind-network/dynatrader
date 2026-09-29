/**
 * JSON-RPC Server for DynaTrader
 *
 * Accepts JSON-RPC 2.0 requests on stdin (one per line) and returns
 * responses on stdout. Also emits server-initiated events (notifications)
 * on stdout — notifications have no `id` field per JSON-RPC 2.0 spec.
 *
 * Uses Node.js readline for line-oriented I/O, making it suitable for
 * terminal integration, piping, and inter-process communication.
 *
 * Architecture:
 * - Tasks 2.1: JSON-RPC server with stdin/stdout transport
 * - Tasks 2.2: Agent event -> JSON-RPC notification bridging
 * - Tasks 2.3: Session management via AgentCore's SessionManager
 */

import * as readline from "node:readline";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { AgentCore } from "../../agent/core/agent-core";
import type { ModelRouterImpl } from "../../orchestration/models/model-router";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ServerEvent,
} from "./types";
import { JsonRpcErrorCodes } from "./types";
import { RpcMethods, RpcEvents } from "./protocol";
import type {
  SessionCreateParams,
  SessionDeleteParams,
  SessionHistoryParams,
  SessionSwitchParams,
  PromptSubmitParams,
  ModelSwitchParams,
  SessionListItem,
  ConversationMessageRPC,
  PromptSubmitResult,
  SessionCreateResult,
  SessionDeleteResult,
  SessionListResult,
  SessionHistoryResult,
  SessionSwitchResult,
  PromptCancelResult,
  ConversationCompactResult,
  ToolListResult,
  AgentDelegateParams,
  AgentDelegateResult,
  AgentDelegateStartResult,
  AgentDelegateStatusResult,
  AgentDelegateCancelResult,
  AgentDelegateListResult,
  DelegatedTask,
  ToolPolicySetParams,
  ToolPolicySetResult,
  ApprovalResolveParams,
  ApprovalResolveResult,
  SessionSetPersonaParams,
  SessionSetPersonaResult,
  ModelSwitchResult,
  ModelListResult,
  ModelActiveResult,
  ModelResetResult,
  AgentStateResult,
} from "./protocol";

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface JsonRpcServerConfig {
  agent: AgentCore;
  modelRouter?: ModelRouterImpl;
}

// ---------------------------------------------------------------------------
// JSON-RPC Server
// ---------------------------------------------------------------------------

export class JsonRpcServer {
  private agent: AgentCore;
  private modelRouter?: ModelRouterImpl;
  private rl: readline.Interface;
  private output: NodeJS.WriteStream;
  private cancelFlag = false;
  private processing = false;
  private autoApproveTools = false;
  private stateCleanup: (() => void) | null = null;
  private delegatedTasks = new Map<string, DelegatedTask>();
  private delegatedTaskControllers = new Map<string, AbortController>();
  private pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(config: JsonRpcServerConfig, inputStream?: NodeJS.ReadStream, outputStream?: NodeJS.WriteStream) {
    this.agent = config.agent;
    this.modelRouter = config.modelRouter;

    const input = inputStream ?? process.stdin;
    const output = outputStream ?? process.stdout;
    this.output = output;

    this.rl = readline.createInterface({
      input,
      output,
      terminal: false,
    });

    this.agent.setToolApprovalHandler((call, definition) => this.requestToolApproval(call, definition));
    this.wireAgentEvents();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start listening for JSON-RPC requests on stdin.
   */
  start(): void {
    this.rl.on("line", (line: string) => {
      this.handleLine(line.trim());
    });

    this.rl.on("close", () => {
      this.stop();
    });
  }

  /**
   * Stop the server and clean up resources.
   */
  stop(): void {
    if (this.stateCleanup) {
      this.stateCleanup();
      this.stateCleanup = null;
    }
    for (const approval of this.pendingApprovals.values()) {
      clearTimeout(approval.timeout);
      approval.resolve(false);
    }
    this.pendingApprovals.clear();
    this.rl.close();
  }

  // -------------------------------------------------------------------------
  // Line handling & dispatch
  // -------------------------------------------------------------------------

  /**
   * Optional auth token from env. If set, all requests must include it.
   */
  private get authToken(): string | undefined {
    return process.env.DYNA_AUTH_TOKEN;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(null, JsonRpcErrorCodes.PARSE_ERROR, "Parse error");
      return;
    }

    const request = parsed as Partial<JsonRpcRequest>;
    if (!request || request.jsonrpc !== "2.0" || !request.method || request.id === undefined) {
      this.sendError(request?.id ?? null, JsonRpcErrorCodes.INVALID_REQUEST, "Invalid request");
      return;
    }

    // Enforce optional authentication via DYNA_AUTH_TOKEN
    const token = this.authToken;
    if (token) {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const requestAuth = params.auth ?? params.authorization ?? params.auth_token;
      const authBuf = Buffer.from(String(requestAuth || ''));
      const tokenBuf = Buffer.from(String(token || ''));
      if (authBuf.length !== tokenBuf.length || !timingSafeEqual(authBuf, tokenBuf)) {
        this.sendError(request.id, JsonRpcErrorCodes.AUTH_ERROR, "Authentication required. Provide 'auth' param matching DYNA_AUTH_TOKEN.");
        return;
      }
    }

    const id = request.id;
    const method = request.method;
    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      const result = await this.dispatch(method, params);
      this.sendResult(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(id, JsonRpcErrorCodes.INTERNAL_ERROR, message);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      // -- Session management (Task 2.3) --
      case RpcMethods.SESSION_CREATE:
        return this.handleSessionCreate(params as SessionCreateParams);
      case RpcMethods.SESSION_DELETE:
        return this.handleSessionDelete(params as unknown as SessionDeleteParams);
      case RpcMethods.SESSION_LIST:
        return this.handleSessionList();
      case RpcMethods.SESSION_HISTORY:
        return this.handleSessionHistory(params as SessionHistoryParams);
      case RpcMethods.SESSION_SWITCH:
        return this.handleSessionSwitch(params as unknown as SessionSwitchParams);

      // -- Prompt handling --
      case RpcMethods.PROMPT_SUBMIT:
        return this.handleSubmit(params as unknown as PromptSubmitParams);
      case RpcMethods.PROMPT_CANCEL:
        return this.handleCancel();
      case RpcMethods.CONVERSATION_COMPACT:
        return this.handleCompact(params);
      case RpcMethods.TOOL_LIST:
        return this.handleToolList(params as { sessionId?: string });
      case RpcMethods.AGENT_DELEGATE:
        return this.handleAgentDelegate(params as unknown as AgentDelegateParams);
      case RpcMethods.AGENT_DELEGATE_START:
        return this.handleAgentDelegateStart(params as unknown as AgentDelegateParams);
      case RpcMethods.AGENT_DELEGATE_STATUS:
        return this.handleAgentDelegateStatus(params as { taskId: string });
      case RpcMethods.AGENT_DELEGATE_CANCEL:
        return this.handleAgentDelegateCancel(params as { taskId: string });
      case RpcMethods.AGENT_DELEGATE_LIST:
        return this.handleAgentDelegateList(params as { sessionId?: string });
      case RpcMethods.TOOL_POLICY_SET:
        return this.handleToolPolicySet(params as ToolPolicySetParams);
      case RpcMethods.APPROVAL_RESOLVE:
        return this.handleApprovalResolve(params as unknown as ApprovalResolveParams);

      // -- Model management --
      case RpcMethods.MODEL_SWITCH:
        return this.handleModelSwitch(params as unknown as ModelSwitchParams);
      case RpcMethods.MODEL_LIST:
        return this.handleModelList();
      case RpcMethods.MODEL_ACTIVE:
        return this.handleModelActive();
      case RpcMethods.MODEL_RESET:
        return this.handleModelReset();

      // -- Agent state --
      case RpcMethods.AGENT_STATE:
        return this.handleAgentState();

      case RpcMethods.SESSION_SET_PERSONA:
        return this.handleSessionSetPersona(params as unknown as SessionSetPersonaParams);

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  // -------------------------------------------------------------------------
  // Session management handlers (Task 2.3)
  // -------------------------------------------------------------------------

  private handleSessionCreate(params: SessionCreateParams): SessionCreateResult {
    const session = this.agent.createSession(params.name);
    this.emitEvent({
      type: RpcEvents.SESSION_UPDATE,
      sessionId: session.id,
      action: "created",
    });
    return {
      sessionId: session.id,
      name: session.name,
      createdAt: session.createdAt.toISOString(),
    };
  }

  private handleSessionDelete(params: SessionDeleteParams): SessionDeleteResult {
    const deleted = this.agent.deleteSession(params.sessionId);
    if (deleted) {
      this.emitEvent({
        type: RpcEvents.SESSION_UPDATE,
        sessionId: params.sessionId,
        action: "deleted",
      });
    }
    return { deleted, sessionId: params.sessionId };
  }

  private handleSessionList(): SessionListResult {
    const sessions = this.agent.listSessions();
    return {
      sessions: sessions.map((s): SessionListItem => ({
        id: s.id,
        name: s.name,
        messageCount: s.messageCount,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  }

  private handleSessionHistory(params: SessionHistoryParams): SessionHistoryResult {
    // If a specific session ID is provided, switch to it temporarily to read messages.
    // Otherwise, use the active session.
    const session = this.agent.getActiveSession();
    if (!session) {
      return { sessionId: "", messages: [] };
    }

    const targetId = params.sessionId ?? session.id;
    let messages = session.messages;

    // If requesting a different session, we need to switch temporarily
    if (params.sessionId && params.sessionId !== session.id) {
      try {
        const switched = this.agent.switchSession(params.sessionId);
        messages = switched.messages;
        // Restore active session
        this.agent.switchSession(session.id);
      } catch {
        return { sessionId: params.sessionId, messages: [] };
      }
    }

    return {
      sessionId: targetId,
      messages: messages.map((m): ConversationMessageRPC => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
      })),
    };
  }

  private handleSessionSwitch(params: SessionSwitchParams): SessionSwitchResult {
    const session = this.agent.switchSession(params.sessionId);
    this.emitEvent({
      type: RpcEvents.SESSION_UPDATE,
      sessionId: session.id,
      action: "switched",
    });
    return {
      sessionId: session.id,
      name: session.name,
      messageCount: session.messages.length,
    };
  }

  private handleSessionSetPersona(params: SessionSetPersonaParams): SessionSetPersonaResult {
    const session = this.agent.getActiveSession();
    if (!session) {
      throw new Error("No active session.");
    }
    const persona = params.persona?.trim() || null;
    session.metadata.persona = persona;
    this.emitEvent({
      type: RpcEvents.SESSION_UPDATE,
      sessionId: session.id,
      action: "persona_changed",
    });
    return { persona, sessionId: session.id };
  }

  // -------------------------------------------------------------------------
  // @name delegation: routes "@agent task" to the local agent registry
  // -------------------------------------------------------------------------

  private async tryDelegateToAgent(
    agentName: string,
    task: string,
    sessionId?: string,
  ): Promise<PromptSubmitResult | null> {
    try {
      const result = await this.agent.delegate({
        agent: agentName,
        task,
        sessionId,
      });
      return {
        content: (result as { result?: string })?.result ?? `@${agentName} completed.`,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        state: 'idle',
        durationMs: 0,
        compacted: false,
      };
    } catch {
      // Agent not found or delegation not configured — fall through to normal prompt processing
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Prompt handlers (Task 2.1 + 2.2 event bridging)
  // -------------------------------------------------------------------------

  private async handleSubmit(params: PromptSubmitParams): Promise<PromptSubmitResult> {
    if (this.processing) {
      throw new Error("A prompt is already being processed. Cancel first or wait.");
    }

    this.processing = true;
    this.cancelFlag = false;
    this.autoApproveTools = params.approvalMode === 'yolo';
    const startedAt = Date.now();

    try {
      // Check for @name delegation pattern: "@agent-name task description"
      const mentionMatch = params.message.match(/^@(\w+)\s+(.+)$/s);
      if (mentionMatch) {
        const [, agentName, task] = mentionMatch;
        const delegatedResult = await this.tryDelegateToAgent(agentName, task.trim(), params.sessionId);
        if (delegatedResult) {
          this.processing = false;
          return delegatedResult;
        }
      }

      // Use chatStream to capture tool lifecycle events and forward them
      // as JSON-RPC notifications (Task 2.2 event bridging).
      const stream = await this.agent.chatStream(params.message, {
        sessionId: params.sessionId,
        templateName: params.templateName,
      });

      let finalContent = "";
      let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finalState = "idle";
      let durationMs = 0;
      let compacted = false;

      for await (const chunk of stream) {
        if (this.cancelFlag) break;

        switch (chunk.type) {
          case "content":
            finalContent += chunk.content ?? "";
            // Emit message.delta event for streaming clients
            this.emitEvent({
              type: RpcEvents.MESSAGE_DELTA,
              content: chunk.content ?? "",
              sessionId: params.sessionId ?? "default",
            });
            break;

          case "tool_call":
            // Emit tool.start event
            this.emitEvent({
              type: RpcEvents.TOOL_START,
              toolCallId: chunk.toolCall!.id,
              toolName: chunk.toolCall!.function.name,
              args: JSON.parse(chunk.toolCall!.function.arguments),
              sessionId: params.sessionId ?? "default",
            });
            break;

          case "tool_result":
            // Emit tool.complete event
            if (chunk.toolResult) {
              this.emitEvent({
                type: RpcEvents.TOOL_COMPLETE,
                toolCallId: chunk.toolResult.toolCallId,
                toolName: "",
                result: chunk.toolResult.result,
                durationMs: chunk.toolResult.result.durationMs,
                success: chunk.toolResult.result.success,
                error: chunk.toolResult.result.error,
                sessionId: params.sessionId ?? "default",
              });
            }
            break;

          case "done":
            finalUsage = chunk.usage ?? finalUsage;
            compacted = true; // Stream completion implies processing happened
            break;

          case "error":
            this.emitEvent({
              type: RpcEvents.ERROR,
              message: chunk.error ?? "Unknown stream error",
              sessionId: params.sessionId ?? "default",
            });
            break;
        }
      }

      finalState = this.agent.getState();
      durationMs = Date.now() - startedAt;

      if (!finalContent.trim()) {
        throw new Error("Prompt produced no visible output.");
      }

      return {
        content: finalContent,
        state: finalState,
        usage: finalUsage,
        durationMs,
        compacted,
      };
    } finally {
      this.processing = false;
      this.cancelFlag = false;
    }
  }

  private handleCancel(): PromptCancelResult {
    if (this.processing) {
      this.agent.cancel();
      this.cancelFlag = true;
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  private handleCompact(params: { sessionId?: string }): ConversationCompactResult {
    if (this.processing) throw new Error("Cannot compact while a prompt is being processed.");
    return this.agent.compactConversation(params.sessionId);
  }

  private handleToolList(params: { sessionId?: string }): ToolListResult {
    return {
      tools: this.agent.listAvailableTools(params.sessionId).map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        readOnly: tool.readOnly,
        riskLevel: tool.riskLevel,
      })),
    };
  }

  private async handleAgentDelegate(params: AgentDelegateParams): Promise<AgentDelegateResult> {
    const result = await this.agent.delegate(params);
    return { agent: params.agent?.trim() ?? '', result };
  }

  private handleAgentDelegateStart(params: AgentDelegateParams): AgentDelegateStartResult {
    if (!params.task?.trim()) throw new Error('Delegated task must not be empty.');
    const agentName = params.agent?.trim();
    if (!agentName) {
      throw new Error('Delegated agent must be specified.');
    }
    const task: DelegatedTask = {
      taskId: `task_${Date.now()}_${randomUUID().slice(0, 8)}`,
      agent: agentName,
      task: params.task.trim(),
      sessionId: params.sessionId ?? this.agent.getActiveSession()?.id ?? 'default',
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    this.delegatedTasks.set(task.taskId, task);
    const controller = new AbortController();
    this.delegatedTaskControllers.set(task.taskId, controller);
    void this.persistDelegatedTask(task);
    this.emitEvent({ type: RpcEvents.AGENT_TASK_UPDATE, task });
    void this.agent.delegate({ ...params, signal: controller.signal }).then(
      (result) => {
        if (task.status === 'cancelled') return;
        task.status = 'completed';
        task.result = result;
        task.completedAt = new Date().toISOString();
        this.delegatedTaskControllers.delete(task.taskId);
        void this.persistDelegatedTask(task);
        this.emitEvent({ type: RpcEvents.AGENT_TASK_UPDATE, task });
      },
      (error) => {
        if (task.status === 'cancelled') return;
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        task.completedAt = new Date().toISOString();
        this.delegatedTaskControllers.delete(task.taskId);
        void this.persistDelegatedTask(task);
        this.emitEvent({ type: RpcEvents.AGENT_TASK_UPDATE, task });
      }
    );
    return { task };
  }

  private handleAgentDelegateStatus(params: { taskId: string }): AgentDelegateStatusResult {
    return { task: this.delegatedTasks.get(params.taskId) };
  }

  private handleAgentDelegateCancel(params: { taskId: string }): AgentDelegateCancelResult {
    const task = this.delegatedTasks.get(params.taskId);
    if (!task || task.status !== 'running') return { cancelled: false, task };
    task.status = 'cancelled';
    this.delegatedTaskControllers.get(task.taskId)?.abort();
    this.delegatedTaskControllers.delete(task.taskId);
    task.completedAt = new Date().toISOString();
    task.error = 'Cancelled by user.';
    void this.persistDelegatedTask(task);
    this.emitEvent({ type: RpcEvents.AGENT_TASK_UPDATE, task });
    return { cancelled: true, task };
  }

  private handleAgentDelegateList(params: { sessionId?: string }): AgentDelegateListResult {
    const tasks = [...this.delegatedTasks.values()]
      .filter((task) => !params.sessionId || task.sessionId === params.sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { tasks };
  }

  private async persistDelegatedTask(task: DelegatedTask): Promise<void> {
    try {
      const directory = path.join(process.cwd(), '.dynamind');
      await mkdir(directory, { recursive: true });
      await appendFile(path.join(directory, 'tasks.jsonl'), `${JSON.stringify(task)}\n`, 'utf8');
    } catch {
      // Persistence must not drop a live task update when the workspace is read-only.
    }
  }

  private handleToolPolicySet(params: ToolPolicySetParams): ToolPolicySetResult {
    this.agent.setToolPolicy(params.sessionId, params.allowedTools, params.disallowedTools);
    return { configured: true, availableTools: this.agent.listAvailableTools(params.sessionId).map((tool) => tool.name) };
  }

  private handleApprovalResolve(params: ApprovalResolveParams): ApprovalResolveResult {
    const pending = this.pendingApprovals.get(params.requestId);
    if (!pending) return { resolved: false };
    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(params.requestId);
    pending.resolve(params.approved);
    return { resolved: true };
  }

  private requestToolApproval(call: import('@dyna/contracts').ToolCall, definition: import('@dyna/contracts').ToolDefinition): Promise<boolean> {
    if (this.autoApproveTools) return Promise.resolve(true);
    const requestId = `approval_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const summary = `${definition.name}: ${definition.description}`;
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve(false);
      }, 5 * 60_000);
      this.pendingApprovals.set(requestId, { resolve, timeout });
      this.emitEvent({
        type: RpcEvents.APPROVAL_REQUEST,
        requestId,
        action: definition.name,
        summary,
        riskLevel: definition.riskLevel ?? 'medium',
        sessionId: this.agent.getActiveSession()?.id ?? 'default',
      });
    });
  }

  // -------------------------------------------------------------------------
  // Model management handlers
  // -------------------------------------------------------------------------

  private handleModelSwitch(params: ModelSwitchParams): ModelSwitchResult {
    if (!this.modelRouter) {
      throw new Error("Model router not configured");
    }
    return this.modelRouter.switchModel(params.modelId);
  }

  private handleModelList(): ModelListResult {
    if (!this.modelRouter) {
      return { models: [] };
    }
    const models = this.modelRouter.listModels();
    return { models };
  }

  private handleModelActive(): ModelActiveResult {
    if (!this.modelRouter) {
      return { activeModel: "auto" };
    }
    return { activeModel: this.modelRouter.getActiveModel() };
  }

  private handleModelReset(): ModelResetResult {
    if (!this.modelRouter) {
      return { reset: false };
    }
    this.modelRouter.resetModel();
    return { reset: true };
  }

  // -------------------------------------------------------------------------
  // Agent state handler
  // -------------------------------------------------------------------------

  private handleAgentState(): AgentStateResult {
    return { state: this.agent.getState() };
  }

  // -------------------------------------------------------------------------
  // Wire agent events to JSON-RPC notifications (Task 2.2)
  // -------------------------------------------------------------------------

  private wireAgentEvents(): void {
    // Bridge agent state changes to session.update notifications
    this.stateCleanup = this.agent.onStateChange((state) => {
      const session = this.agent.getActiveSession();
      if (session) {
        this.emitEvent({
          type: RpcEvents.SESSION_UPDATE,
          sessionId: session.id,
          action: "updated",
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Wire protocol: write JSON-RPC to stdout
  // -------------------------------------------------------------------------

  private sendResult(id: number | string, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.writeLine(response);
  }

  private sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: id ?? 0,
      error: { code, message, data },
    };
    this.writeLine(response);
  }

  /**
   * Emit a server-initiated notification (no `id` field).
   */
  private emitEvent(event: ServerEvent): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: event.type,
      params: event as unknown as Record<string, unknown>,
    };
    this.writeLine(notification);
  }

  private writeLine(obj: unknown): void {
    const line = JSON.stringify(obj);
    this.output.write(line + "\n");
  }
}
