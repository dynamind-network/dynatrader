import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  HaltTradingTool,
  ResumeTradingTool,
  TradingHaltStatusTool,
} from "./risk-tools";
import { HaltState } from "../../runtime/halt/halt-state";

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "risk-tools-test-"));
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

describe("Risk tools", () => {
  it("halt_trading halts globally and returns confirmation", async () => {
    const tool = new HaltTradingTool({ workspacePath });
    const result = await tool.execute({
      tool: "halt_trading",
      args: { reason: "detected anomaly" },
    });
    expect(result.success).toBe(true);
    expect((result.data as any).halted).toBe(true);
    expect((result.data as any).scope).toBe("global");

    // Enforcement state actually persisted
    const hs = new HaltState(join(workspacePath, "state"));
    expect(hs.isHalted()).toBe(true);
  });

  it("halt_trading with symbol scope blocks only that symbol", async () => {
    const tool = new HaltTradingTool({ workspacePath });
    await tool.execute({ tool: "halt_trading", args: { reason: "vol spike", scope: "BTC/USDT" } });

    const hs = new HaltState(join(workspacePath, "state"));
    expect(hs.isHalted("BTC/USDT")).toBe(true);
    expect(hs.isHalted("ETH/USDT")).toBe(false);
  });

  it("resume_trading lifts all halts without scope", async () => {
    const haltTool = new HaltTradingTool({ workspacePath });
    await haltTool.execute({ tool: "halt_trading", args: { reason: "a" } });

    const resumeTool = new ResumeTradingTool({ workspacePath });
    const result = await resumeTool.execute({ tool: "resume_trading", args: {} });
    expect(result.success).toBe(true);
    expect((result.data as any).liftedCount).toBe(1);

    const hs = new HaltState(join(workspacePath, "state"));
    expect(hs.isHalted()).toBe(false);
  });

  it("resume_trading with symbol lifts only that symbol", async () => {
    const haltTool = new HaltTradingTool({ workspacePath });
    await haltTool.execute({ tool: "halt_trading", args: { reason: "a", scope: "BTC/USDT" } });
    await haltTool.execute({ tool: "halt_trading", args: { reason: "b", scope: "ETH/USDT" } });

    const resumeTool = new ResumeTradingTool({ workspacePath });
    await resumeTool.execute({ tool: "resume_trading", args: { scope: "BTC/USDT" } });

    const hs = new HaltState(join(workspacePath, "state"));
    expect(hs.isHalted("BTC/USDT")).toBe(false);
    expect(hs.isHalted("ETH/USDT")).toBe(true);
  });

  it("trading_halt_status reports active halts", async () => {
    const haltTool = new HaltTradingTool({ workspacePath });
    await haltTool.execute({ tool: "halt_trading", args: { reason: "status check" } });

    const statusTool = new TradingHaltStatusTool({ workspacePath });
    const result = await statusTool.execute({ tool: "trading_halt_status", args: {} });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.halted).toBe(true);
    expect(data.halts[0].reason).toBe("status check");
    expect(data.halts[0].source).toBe("agent");
  });

  it("trading_halt_status reports clear when unhalted", async () => {
    const statusTool = new TradingHaltStatusTool({ workspacePath });
    const result = await statusTool.execute({ tool: "trading_halt_status", args: {} });
    expect((result.data as any).halted).toBe(false);
  });
});

import { CheckCircuitBreakersTool } from "./risk-tools";

describe("CheckCircuitBreakersTool", () => {
  it("reports within-limits status when no outcomes recorded", async () => {
    const tool = new CheckCircuitBreakersTool({ workspacePath });
    const res = await tool.execute({ tool: "check_circuit_breakers", args: {} });
    expect(res.success).toBe(true);
    expect((res.data as any).tripped).toBe(false);
  });
});
