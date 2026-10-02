import { describe, it, expect, vi, beforeEach } from "vitest";
import { A2ARuntime } from "./a2a-runtime";
import { AgentCardManager } from "./agent-card";
import { TaskManager } from "./task-manager";
import type { AgentCard, A2APolicy, GatewayClient } from "./types";

// --- Mock SubagentRuntime (in-process mode) ---

function createMockSubagentRuntime(overrides?: {
  lastOutput?: unknown;
  executeError?: Error;
}) {
  return {
    executeAgent: vi.fn().mockImplementation(
      async (agentName: string, mode: string, input: unknown) => {
        if (overrides?.executeError) {
          throw overrides.executeError;
        }
        return {
          agentName,
          mode,
          depth: 1,
          maxDepth: 2,
          permissions: {
            allowedTools: ["read", "write"],
            allowedSkills: ["analysis"],
            memoryAccess: { read: ["market"], write: ["reports"] },
          },
        };
      },
    ),
    getLastOutput: vi.fn().mockReturnValue(
      overrides?.lastOutput ?? { agentName: "test-agent", mode: "paper", result: "done" },
    ),
  };
}

// --- Mock Gateway ---

function createMockGateway(overrides?: {
  spawnResult?: { runId?: string; sessionKey?: string; status?: string; error?: string };
  waitResult?: { status?: string; error?: string };
  historyResult?: { messages: Array<{ role: string; content?: string; text?: string }> };
  sendError?: Error;
}): GatewayClient {
  return {
    call: vi.fn().mockResolvedValue(overrides?.spawnResult ?? {
      runId: "run-001",
      sessionKey: "session-001",
      status: "ok",
    }),
    callWait: vi.fn().mockResolvedValue(overrides?.waitResult ?? {
      status: "completed",
    }),
    history: vi.fn().mockResolvedValue(overrides?.historyResult ?? {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello from agent!" },
      ],
    }),
    send: overrides?.sendError
      ? vi.fn().mockRejectedValue(overrides.sendError)
      : vi.fn().mockResolvedValue(undefined),
  };
}

function makeTestCard(overrides?: Partial<AgentCard>): AgentCard {
  return {
    name: "test-agent",
    description: "A test agent",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      { id: "skill-a", name: "Skill A", description: "Test skill", tags: ["test", "demo"], examples: [] },
    ],
    ...overrides,
  };
}

// --- AgentCardManager ---

describe("AgentCardManager", () => {
  let manager: AgentCardManager;

  beforeEach(() => {
    manager = new AgentCardManager();
  });

  it("registers and retrieves an agent card", () => {
    const card = makeTestCard();
    manager.register("agent-1", card);

    const retrieved = manager.get("agent-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("test-agent");
    expect(retrieved!.version).toBe("1.0.0");
  });

  it("returns undefined for unknown agent", () => {
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered cards", () => {
    manager.register("a", makeTestCard({ name: "agent-a" }));
    manager.register("b", makeTestCard({ name: "agent-b" }));

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map(e => e.id).sort()).toEqual(["a", "b"]);
  });

  it("discovers agents by skill ID", () => {
    manager.register("a", makeTestCard({
      skills: [{ id: "trading", name: "Trading", description: "Trade", tags: ["finance"], examples: [] }],
    }));
    manager.register("b", makeTestCard({
      skills: [{ id: "analysis", name: "Analysis", description: "Analyze", tags: ["data"], examples: [] }],
    }));

    const found = manager.discover({ skills: ["trading"] });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("a");
  });

  it("discovers agents by tag", () => {
    manager.register("a", makeTestCard({
      skills: [{ id: "s1", name: "S1", description: "", tags: ["risk", "finance"], examples: [] }],
    }));
    manager.discover({ tags: ["risk"] });
    const found = manager.discover({ tags: ["risk"] });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("a");
  });

  it("returns empty for no matches", () => {
    manager.register("a", makeTestCard());
    const found = manager.discover({ skills: ["nonexistent"] });
    expect(found).toHaveLength(0);
  });

  it("generates well-known format", () => {
    const card = makeTestCard();
    const wellKnown = manager.toWellKnown(card);
    expect(wellKnown).toHaveProperty("name", "test-agent");
    expect(wellKnown).toHaveProperty("capabilities");
    expect(wellKnown).toHaveProperty("skills");
    // Should not include auth credentials in well-known
    expect(wellKnown).not.toHaveProperty("credentials");
  });
});

// --- TaskManager ---

describe("TaskManager", () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager();
  });

  it("creates a task with submitted state", () => {
    const task = manager.createTask("session-1");
    expect(task.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(task.sessionId).toBe("session-1");
    expect(task.status.state).toBe("submitted");
    expect(task.status.timestamp).toBeDefined();
    expect(task.artifacts).toEqual([]);
    expect(task.history).toEqual([]);
  });

  it("creates a task with custom initial state", () => {
    const task = manager.createTask("s1", { state: "working" });
    expect(task.status.state).toBe("working");
  });

  it("retrieves a task by ID", () => {
    const task = manager.createTask("s1");
    const retrieved = manager.getTask(task.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(task.id);
  });

  it("returns undefined for unknown task", () => {
    expect(manager.getTask("nonexistent")).toBeUndefined();
  });

  it("updates task state and records history", () => {
    const task = manager.createTask("s1");
    const updated = manager.updateState(task.id, "working");

    expect(updated).toBeDefined();
    expect(updated!.status.state).toBe("working");
    expect(updated!.history).toHaveLength(1);
    expect(updated!.history[0].state).toBe("submitted");
  });

  it("tracks multiple state transitions", () => {
    const task = manager.createTask("s1");
    manager.updateState(task.id, "working");
    manager.updateState(task.id, "completed");

    const retrieved = manager.getTask(task.id)!;
    expect(retrieved.status.state).toBe("completed");
    expect(retrieved.history).toHaveLength(2);
    expect(retrieved.history.map((h: { state: string }) => h.state)).toEqual(["submitted", "working"]);
  });

  it("returns undefined when updating nonexistent task", () => {
    expect(manager.updateState("bad-id", "completed")).toBeUndefined();
  });

  it("gets all tasks for a session", () => {
    manager.createTask("s1");
    manager.createTask("s1");
    manager.createTask("s2");

    const s1Tasks = manager.getSessionTasks("s1");
    expect(s1Tasks).toHaveLength(2);

    const s2Tasks = manager.getSessionTasks("s2");
    expect(s2Tasks).toHaveLength(1);
  });

  it("adds artifacts to a task", () => {
    const task = manager.createTask("s1");
    manager.addArtifact(task.id, { type: "chart", data: "..." });
    manager.addArtifact(task.id, { type: "report", data: "..." });

    const retrieved = manager.getTask(task.id)!;
    expect(retrieved.artifacts).toHaveLength(2);
  });

  it("silently ignores artifact add for nonexistent task", () => {
    // Should not throw
    manager.addArtifact("nonexistent", { data: 1 });
  });

  it("cancels a task", () => {
    const task = manager.createTask("s1");
    const canceled = manager.cancelTask(task.id);
    expect(canceled!.status.state).toBe("canceled");
  });
});

// --- A2ARuntime ---

describe("A2ARuntime", () => {
  const defaultPolicy: A2APolicy = {
    enabled: false,
    allow: [],
    maxPingPongTurns: 5,
    announceTimeoutMs: 300000,
    visibility: "tree",
  };

  describe("security policy", () => {
    it("allows all when policy is disabled", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: false },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "agent-b")).toBe(true);
    });

    it("allows self-communication always", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: [] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "agent-a")).toBe(true);
    });

    it("denies when no patterns match", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: ["agent-x"] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "agent-b")).toBe(false);
    });

    it("allows exact match", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: ["agent-b"] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "agent-b")).toBe(true);
    });

    it("allows wildcard *", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: ["*"] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "anything")).toBe(true);
    });

    it("allows prefix wildcard analyst-*", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: ["analyst-*"] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "analyst-1")).toBe(true);
      expect(runtime.isAllowed("agent-a", "analyst-xyz")).toBe(true);
      expect(runtime.isAllowed("agent-a", "trader-1")).toBe(false);
    });

    it("allows suffix wildcard *-agent", () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: ["*-agent"] },
        agentId: "agent-a",
      });
      expect(runtime.isAllowed("agent-a", "risk-agent")).toBe(true);
      expect(runtime.isAllowed("agent-a", "trader")).toBe(false);
    });
  });

  describe("card management", () => {
    it("registers and discovers cards", () => {
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        agentId: "agent-a",
      });
      runtime.registerCard(makeTestCard({ name: "My Agent" }));

      const cards = runtime.getCards().list();
      expect(cards).toHaveLength(1);
      expect(cards[0]!.card.name).toBe("My Agent");
    });

    it("discovers by skill", () => {
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        agentId: "agent-a",
      });
      runtime.registerCard(makeTestCard({
        skills: [{ id: "risk", name: "Risk", description: "", tags: [], examples: [] }],
      }));

      const found = runtime.discoverAgents({ skills: ["risk"] });
      expect(found).toHaveLength(1);
    });
  });

  describe("sendAndReceive", () => {
    it("sends message and receives response via gateway", async () => {
      const gateway = createMockGateway();
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "Analyze BTC",
      });

      expect(result.response).toBe("Hello from agent!");
      expect(result.task).toBeDefined();
      expect(result.task!.status.state).toBe("completed");
      expect(gateway.call).toHaveBeenCalledWith("spawn_subagent", expect.objectContaining({
        task: "Analyze BTC",
        agentId: "agent-b",
      }));
    });

    it("sends message and receives response via subagentRuntime (in-process)", async () => {
      const subagentRuntime = createMockSubagentRuntime();
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        subagentRuntime,
        agentId: "agent-a",
      });

      const result = await runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "Analyze BTC",
      });

      expect(result.task).toBeDefined();
      expect(result.task!.status.state).toBe("completed");
      // Response should contain the execution context as JSON
      expect(result.response).toContain("agent-b");
      expect(result.response).toContain("depth");
      expect(result.response).toContain("permissions");
      expect(subagentRuntime.executeAgent).toHaveBeenCalledWith(
        "agent-b",
        "paper",
        expect.objectContaining({ task: "Analyze BTC" }),
      );
    });

    it("throws when policy denies", async () => {
      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: true, allow: [] },
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("A2A policy denied");
    });

    it("throws when neither gateway nor subagentRuntime configured", async () => {
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("No gateway or subagentRuntime configured");
    });

    it("handles subagentRuntime execution error", async () => {
      const subagentRuntime = createMockSubagentRuntime({
        executeError: new Error("Agent not found"),
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        subagentRuntime,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("A2A execution failed");

      // Task should be marked failed
      const tasks = runtime.getTasks().getSessionTasks("unknown");
      expect(tasks.some(t => t.status.state === "failed")).toBe(true);
    });

    it("handles gateway spawn error", async () => {
      const gateway = createMockGateway({
        spawnResult: { status: "error", error: "Agent not found" },
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("Agent not found");

      // Task should be marked failed
      const tasks = runtime.getTasks().getSessionTasks("unknown");
      expect(tasks.some(t => t.status.state === "failed")).toBe(true);
    });

    it("handles gateway spawn returning no runId", async () => {
      const gateway = createMockGateway({
        spawnResult: { status: "ok" }, // no runId
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("No run ID returned");
    });

    it("handles gateway timeout", async () => {
      const gateway = createMockGateway({
        waitResult: { status: "timeout" },
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("timed out");
    });

    it("handles gateway execution error", async () => {
      const gateway = createMockGateway({
        waitResult: { status: "error", error: "Runtime crashed" },
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      await expect(runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      })).rejects.toThrow("Runtime crashed");
    });

    it("returns 'No response' when history has no assistant messages", async () => {
      const gateway = createMockGateway({
        historyResult: { messages: [{ role: "user", content: "hello" }] },
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.sendAndReceive({
        targetAgentId: "agent-b",
        message: "hello",
      });

      expect(result.response).toBe("No response");
    });
  });

  describe("pingPong", () => {
    it("limits turns to maxPingPongTurns", async () => {
      let callCount = 0;
      const gateway = createMockGateway();
      (gateway.call as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        return { runId: `run-${callCount}`, sessionKey: `session-${callCount}`, status: "ok" };
      });
      (gateway.history as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        messages: [{ role: "assistant", content: `reply-${callCount}` }],
      }));

      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, enabled: false, maxPingPongTurns: 3 },
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.pingPong({
        targetAgentId: "agent-b",
        initialMessage: "start",
      });

      expect(result.turns).toHaveLength(3);
      expect(result.finalResponse).toBe("reply-3");
    });

    it("stops on REPLY_SKIP", async () => {
      let callCount = 0;
      const gateway = createMockGateway();
      (gateway.history as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return { messages: [{ role: "assistant", content: "REPLY_SKIP" }] };
        }
        return { messages: [{ role: "assistant", content: `reply-${callCount}` }] };
      });

      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, maxPingPongTurns: 5 },
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.pingPong({
        targetAgentId: "agent-b",
        initialMessage: "start",
      });

      expect(result.turns).toHaveLength(2);
      expect(result.finalResponse).toBe("REPLY_SKIP");
    });

    it("calls onTurn callback for each turn", async () => {
      const gateway = createMockGateway();
      const onTurn = vi.fn();

      const runtime = new A2ARuntime({
        policy: { ...defaultPolicy, maxPingPongTurns: 2 },
        gateway,
        agentId: "agent-a",
      });

      await runtime.pingPong({
        targetAgentId: "agent-b",
        initialMessage: "start",
        onTurn,
      });

      expect(onTurn).toHaveBeenCalledTimes(2);
      expect(onTurn).toHaveBeenCalledWith(1, "start");
    });
  });

  describe("announce", () => {
    it("sends response to external channel", async () => {
      const gateway = createMockGateway();
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.announce({
        targetAgentId: "agent-b",
        message: "get status",
        announceTarget: { to: "user-123", channel: "telegram" },
      });

      expect(result.response).toBe("Hello from agent!");
      expect(result.announced).toBe(true);
      expect(gateway.send).toHaveBeenCalledWith({
        to: "user-123",
        message: "Hello from agent!",
        channel: "telegram",
        accountId: undefined,
      });
    });

    it("returns announced=false on ANNOUNCE_SKIP", async () => {
      const gateway = createMockGateway({
        historyResult: { messages: [{ role: "assistant", content: "ANNOUNCE_SKIP" }] },
      });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      const result = await runtime.announce({
        targetAgentId: "agent-b",
        message: "status",
        announceTarget: { to: "user-123" },
      });

      expect(result.announced).toBe(false);
      expect(gateway.send).not.toHaveBeenCalled();
    });

    it("returns announced=false when using subagentRuntime (no gateway)", async () => {
      const subagentRuntime = createMockSubagentRuntime();
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        subagentRuntime,
        agentId: "agent-a",
      });

      const result = await runtime.announce({
        targetAgentId: "agent-b",
        message: "status",
        announceTarget: { to: "user-123" },
      });

      // sendAndReceive works via subagentRuntime, but announce has no gateway to send
      expect(result.announced).toBe(false);
      expect(result.response).toBeTruthy();
    });

    it("throws when gateway.send fails", async () => {
      const gateway = createMockGateway({ sendError: new Error("send failed") });
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        gateway,
        agentId: "agent-a",
      });

      await expect(runtime.announce({
        targetAgentId: "agent-b",
        message: "status",
        announceTarget: { to: "user-123" },
      })).rejects.toThrow("send failed");
    });
  });

  describe("accessors", () => {
    it("exposes card manager, task manager, and policy", () => {
      const runtime = new A2ARuntime({
        policy: defaultPolicy,
        agentId: "agent-a",
      });

      expect(runtime.getCards()).toBeInstanceOf(AgentCardManager);
      expect(runtime.getTasks()).toBeInstanceOf(TaskManager);
      expect(runtime.getPolicy()).toBe(defaultPolicy);
    });
  });
});
