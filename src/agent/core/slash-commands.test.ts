import { describe, expect, it, vi, beforeEach } from "vitest";
import { SlashCommandRegistry, registerDefaultCommands } from "./slash-commands";
import { GoalLoopManager } from "./goal-loop";

function registry(): SlashCommandRegistry {
  const result = new SlashCommandRegistry();
  registerDefaultCommands(result);
  return result;
}

const loop = new GoalLoopManager();

describe("general slash commands", () => {
  it("sets and manages a goal loop", async () => {
    const commands = registry();
    const ctx = { agent: { getGoalLoop: () => loop } };
    const result = await commands.execute("/goal Ship release", ctx);
    expect(result?.content).toContain("Goal set");
    expect((await commands.execute("/goal status", ctx))?.content).toContain("Ship release");
    await commands.execute("/goal pause", ctx);
    expect((await commands.execute("/goal status", ctx))?.content).toContain("[paused]");
    await commands.execute("/goal resume", ctx);
    expect((await commands.execute("/goal clear", ctx))?.content).toContain("cleared");
  });

  it("creates a skill from a completed task", async () => {
    const createSkillFromTask = vi.fn().mockResolvedValue({ name: "debug-websocket" });
    const result = await registry().execute("/skill create Debug websocket -- Inspect close events", { skillFactory: { createSkillFromTask } });
    expect(result?.content).toBe("Skill created: debug-websocket");
    expect(createSkillFromTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Debug websocket", successful: true }));
  });

  it("runs a dream cycle", async () => {
    const runDreamCycle = vi.fn().mockResolvedValue({ id: "dream-1", summary: "Found two patterns" });
    const result = await registry().execute("/dream", { dreamEngine: { runDreamCycle } });
    expect(result?.content).toContain("Found two patterns");
  });
});

describe("DynaTrader slash commands", () => {
  let commands: SlashCommandRegistry;

  beforeEach(() => {
    commands = registry();
  });

  it("should have /me command", async () => {
    const result = await commands.execute("/me", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Agent Profile");
  });

  it("should have /p command", async () => {
    const result = await commands.execute("/p", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Portfolio");
  });

  it("should have /portfolio alias", async () => {
    const result = await commands.execute("/portfolio", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Portfolio");
  });

  it("should have /positions command", async () => {
    const result = await commands.execute("/positions", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Positions");
  });

  it("should have /pnl command", async () => {
    const result = await commands.execute("/pnl", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("PnL");
  });

  it("should have /alerts command", async () => {
    const result = await commands.execute("/alerts", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Alerts");
  });

  it("should have /sim command", async () => {
    const result = await commands.execute("/sim", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Simulation");
  });

  it("should still have /help command", async () => {
    const result = await commands.execute("/help", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Available commands");
  });

  it("/p and /portfolio return same content", async () => {
    const pResult = await commands.execute("/p", {});
    const portfolioResult = await commands.execute("/portfolio", {});
    expect(pResult!.content).toBe(portfolioResult!.content);
  });

  it("should still have /version command", async () => {
    const result = await commands.execute("/version", {});
    expect(result).not.toBeNull();
    expect(result!.content).toContain("DynaTrader");
  });

  it("/me shows agent info when agent is provided", async () => {
    const mockAgent = { agentId: "agent-123", mode: "live", executionMode: "paper" };
    const mockModelRouter = { getActiveModel: () => ({ name: "gpt-4" }) };
    const result = await commands.execute("/me", { agent: mockAgent, modelRouter: mockModelRouter });
    expect(result!.content).toContain("agent-123");
    expect(result!.content).toContain("gpt-4");
  });

  it("/sim start calls dreamEngine.start", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const result = await commands.execute("/sim start", { dreamEngine: { start } });
    expect(start).toHaveBeenCalledOnce();
    expect(result!.content).toContain("started");
  });

  it("/sim stop calls dreamEngine.stop", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const result = await commands.execute("/sim stop", { dreamEngine: { stop } });
    expect(stop).toHaveBeenCalledOnce();
    expect(result!.content).toContain("stopped");
  });
});