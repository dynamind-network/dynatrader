import type { AgentCard, A2APolicy, GatewayClient, InputProvenance, A2AMessage } from "./types";
import { AgentCardManager } from "./agent-card";
import { TaskManager } from "./task-manager";

export interface A2ARuntimeConfig {
  policy: A2APolicy;
  gateway?: GatewayClient;
  /** In-process SubagentRuntime for direct agent execution (alternative to gateway) */
  subagentRuntime?: {
    executeAgent(
      agentName: string,
      mode: string,
      input: unknown,
    ): Promise<{
      agentName: string;
      mode: string;
      depth: number;
      maxDepth: number;
      permissions: { allowedTools: string[]; allowedSkills: string[]; memoryAccess: { read: string[]; write: string[] } };
    }>;
    getLastOutput(): unknown;
  };
  agentId: string;
  enableLogging?: boolean;
}

export class A2ARuntime {
  private policy: A2APolicy;
  private gateway?: GatewayClient;
  private subagentRuntime?: A2ARuntimeConfig["subagentRuntime"];
  private agentId: string;
  private enableLogging: boolean;
  private cardManager: AgentCardManager;
  private taskManager: TaskManager;

  constructor(config: A2ARuntimeConfig) {
    this.policy = config.policy;
    this.gateway = config.gateway;
    this.subagentRuntime = config.subagentRuntime;
    this.agentId = config.agentId;
    this.enableLogging = config.enableLogging ?? false;
    this.cardManager = new AgentCardManager();
    this.taskManager = new TaskManager();
  }

  // --- Agent Card ---
  
  registerCard(card: AgentCard): void {
    this.cardManager.register(card.name, card);
  }

  discoverAgents(query?: { skills?: string[]; tags?: string[] }) {
    return this.cardManager.discover(query);
  }

  // --- Security ---

  isAllowed(requesterId: string, targetId: string): boolean {
    if (!this.policy.enabled) return true;
    if (requesterId === targetId) return true;
    return this.policy.allow.some(pattern => {
      if (pattern === "*") return true;
      if (pattern.endsWith("*")) return targetId.startsWith(pattern.slice(0, -1));
      if (pattern.startsWith("*")) return targetId.endsWith(pattern.slice(1));
      return pattern === targetId;
    });
  }

  // --- Task Management ---

  createTask(sessionId: string) {
    return this.taskManager.createTask(sessionId);
  }

  getTask(taskId: string) {
    return this.taskManager.getTask(taskId);
  }

  // --- A2A Messaging ---

  /**
   * Send a message to another agent and wait for response.
   * Pattern A: Request/Response
   */
  async sendAndReceive(params: {
    targetAgentId: string;
    message: string;
    provenance?: InputProvenance;
    timeoutMs?: number;
  }): Promise<{ response: string; task: ReturnType<TaskManager["getTask"]> }> {
    const { targetAgentId, message, provenance, timeoutMs = 120_000 } = params;

    // Security check
    if (!this.isAllowed(this.agentId, targetAgentId)) {
      throw new Error(`A2A policy denied: ${this.agentId} -> ${targetAgentId}`);
    }

    // Create task
    const task = this.taskManager.createTask(
      provenance?.sourceSessionKey ?? "unknown",
      { state: "submitted" }
    );

    if (this.enableLogging) {
      console.log(`[a2a] ${this.agentId} -> ${targetAgentId}: ${message.slice(0, 100)}...`);
    }

    this.taskManager.updateState(task.id, "working");

    let response: string;

    if (this.subagentRuntime) {
      // In-process mode: execute the target agent directly via SubagentRuntime
      try {
        const context = await this.subagentRuntime.executeAgent(
          targetAgentId,
          "paper",
          { task: message, provenance },
        );

        response = JSON.stringify({
          agentName: context.agentName,
          mode: context.mode,
          depth: context.depth,
          maxDepth: context.maxDepth,
          permissions: context.permissions,
        });
      } catch (err) {
        this.taskManager.updateState(task.id, "failed");
        throw new Error(`A2A execution failed: ${(err as Error).message}`);
      }
    } else if (this.gateway) {
      // Out-of-process mode: route through external gateway
      const sendResult = await this.gateway.call<{
        runId?: string;
        sessionKey?: string;
        status?: string;
        error?: string;
      }>("spawn_subagent", {
        task: message,
        agentId: targetAgentId,
        runTimeoutSeconds: Math.floor(timeoutMs / 1000),
        cleanup: "keep",
        inputProvenance: provenance ?? {
          kind: "inter_session",
          sourceSessionKey: "direct",
          sourceTool: "a2a-runtime",
        },
      });

      if (!sendResult || sendResult.status === "error") {
        this.taskManager.updateState(task.id, "failed");
        throw new Error(sendResult?.error ?? `Failed to send to ${targetAgentId}`);
      }

      const { runId, sessionKey } = sendResult;

      if (!runId) {
        this.taskManager.updateState(task.id, "failed");
        throw new Error("No run ID returned from spawn");
      }

      // Wait for completion
      const waitResult = await this.gateway.callWait<{ status?: string; error?: string }>(
        runId,
        timeoutMs
      );

      if (waitResult?.status === "timeout") {
        this.taskManager.updateState(task.id, "failed");
        throw new Error("A2A message timed out");
      }

      if (waitResult?.status === "error") {
        this.taskManager.updateState(task.id, "failed");
        throw new Error(waitResult.error ?? "A2A execution failed");
      }

      // Fetch response
      const history = await this.gateway.history(sessionKey!, 10);
      const assistantMessages = history.messages.filter(m => m.role === "assistant");
      const lastMessage = assistantMessages[assistantMessages.length - 1];
      response = lastMessage?.content || lastMessage?.text || "No response";
    } else {
      throw new Error("No gateway or subagentRuntime configured for A2A messaging");
    }

    this.taskManager.updateState(task.id, "completed");

    return { response, task: this.taskManager.getTask(task.id) };
  }

  /**
   * Multi-turn A2A conversation.
   * Pattern B: Ping-Pong Chaining
   */
  async pingPong(params: {
    targetAgentId: string;
    initialMessage: string;
    maxTurns?: number;
    provenance?: InputProvenance;
    onTurn?: (turn: number, message: string) => void;
  }): Promise<{ turns: Array<{ turn: number; from: string; message: string }>; finalResponse: string }> {
    const { targetAgentId, initialMessage, maxTurns = this.policy.maxPingPongTurns, provenance } = params;
    const turns: Array<{ turn: number; from: string; message: string }> = [];
    
    let currentMessage = initialMessage;
    let currentTarget = targetAgentId;
    let currentSource = this.agentId;

    for (let turn = 1; turn <= maxTurns; turn++) {
      params.onTurn?.(turn, currentMessage);
      
      const { response } = await this.sendAndReceive({
        targetAgentId: currentTarget,
        message: currentMessage,
        provenance: provenance ?? {
          kind: "inter_session",
          sourceSessionKey: "ping-pong",
          sourceTool: "a2a-runtime",
          timestamp: new Date().toISOString(),
        },
      });

      turns.push({ turn, from: currentTarget, message: response });

      // Check for REPLY_SKIP
      if (response.trim() === "REPLY_SKIP") {
        break;
      }

      // Swap roles for next turn
      currentMessage = response;
      const temp = currentSource;
      currentSource = currentTarget;
      currentTarget = temp;
    }

    return { turns, finalResponse: turns[turns.length - 1]?.message ?? "" };
  }

  /**
   * Send message and announce result to external channel.
   * Pattern C: Announce
   */
  async announce(params: {
    targetAgentId: string;
    message: string;
    announceTarget: { to: string; channel?: string; accountId?: string };
    provenance?: InputProvenance;
  }): Promise<{ response: string; announced: boolean }> {
    const { targetAgentId, message, announceTarget, provenance } = params;

    const { response } = await this.sendAndReceive({
      targetAgentId,
      message,
      provenance,
    });

    // Check for ANNOUNCE_SKIP
    if (response.trim() === "ANNOUNCE_SKIP") {
      return { response, announced: false };
    }

    // Send announce to external channel
    if (this.gateway) {
      await this.gateway.send({
        to: announceTarget.to,
        message: response,
        channel: announceTarget.channel,
        accountId: announceTarget.accountId,
      });
      return { response, announced: true };
    }

    // Log the announce for in-process mode
    if (this.enableLogging) {
      console.log(`[a2a] announce: to=${announceTarget.to}, channel=${announceTarget.channel ?? 'default'}, message=${response.slice(0, 100)}`);
    }

    return { response, announced: false };
  }

  // --- Accessors ---

  getCards() { return this.cardManager; }
  getTasks() { return this.taskManager; }
  getPolicy() { return this.policy; }
}
