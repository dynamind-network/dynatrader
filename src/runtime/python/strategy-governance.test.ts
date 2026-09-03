/**
 * PythonStrategyGovernance tests
 *
 * Exercises the governance pipeline with an in-process fake strategy service
 * (no Python child process) and an in-memory fake approval system: fast-fail
 * hard-gate denial, Python risk denial, the approval-required path and the
 * execute path, plus audit recording and strategy.* bus emissions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { PythonStrategyGovernance, DefaultHardGate } from "./strategy-governance";
import type {
  HardGate,
  PythonStrategyGovernanceConfig,
  StrategyApprovalSystem,
} from "./strategy-governance";
import type { PythonStrategyService } from "./strategy-plugin";
import type {
  BacktestMetrics,
  RiskGate,
  StrategySignal,
} from "./strategy-bridge";
import { AuditTrail } from "@dyna/audit";

const FAKE_METRICS: BacktestMetrics = {
  total_return: 12.5,
  max_drawdown: 300,
  max_drawdown_pct: 0.03,
  win_rate: 0.6,
  total_trades: 10,
  wins: 6,
  losses: 4,
  avg_win: 40,
  avg_loss: 15,
  profit_factor: 1.6,
  net_pnl: 180,
  empty: false,
};

class FakePythonStrategyService implements PythonStrategyService {
  riskGate: RiskGate = { approved: true, reason: "ok", suggested_size: 0.05 };
  readonly riskCheck = vi.fn(
    async (
      _signal: Record<string, unknown>,
      _positionSize: number,
      _maxRisk: number,
    ): Promise<RiskGate> => this.riskGate,
  );
  readonly info = vi.fn(async () => ({
    name: "fake",
    long_name: "Fake Strategy",
    version: "0.0.0",
    description: "test double",
    methods: ["strategy.risk_check"],
  }));
  readonly health = vi.fn(async () => ({
    status: "ok",
    name: "fake",
    pid: 0,
    uptime_s: 0,
  }));
  readonly onMarket = vi.fn(
    async (symbol: string): Promise<StrategySignal> => signalFor(symbol),
  );
  readonly generateSignals = vi.fn(
    async (symbols: string[]): Promise<StrategySignal[]> => symbols.map(signalFor),
  );
  readonly validateBacktest = vi.fn(
    async (): Promise<BacktestMetrics> => FAKE_METRICS,
  );
  readonly stop = vi.fn(async () => {});
}

class FakeApprovalSystem implements StrategyApprovalSystem {
  required = true;
  readonly requiresApproval = vi.fn((): boolean => this.required);
  readonly createRequest = vi.fn(async (): Promise<string> => "approval-1");
}

function signalFor(symbol: string): StrategySignal {
  return {
    symbol,
    action: "buy",
    confidence: 0.8,
    reasoning: "momentum",
  };
}

const SIGNAL: StrategySignal = signalFor("BTCUSDT");

function makeConfig(
  overrides: Partial<PythonStrategyGovernanceConfig> = {},
): PythonStrategyGovernanceConfig {
  return {
    positionSize: 0.05,
    maxRisk: 0.02,
    portfolioValue: 100_000,
    regime: "ranging",
    circuitState: {
      dailyLoss: false,
      weeklyLoss: false,
      marketCircuit: false,
      llmFailure: false,
    },
    kellyPct: 0.05,
    requester: "strategy-bot",
    sessionId: "session-1",
    ...overrides,
  };
}

function healthyGate(): HardGate {
  return new DefaultHardGate();
}

describe("PythonStrategyGovernance", () => {
  let strategy: FakePythonStrategyService;
  let approvals: FakeApprovalSystem;
  let audit: AuditTrail;
  let workDir: string;
  let emitted: Array<{ event: string; payload: unknown }>;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "strategy-governance-"));
    strategy = new FakePythonStrategyService();
    approvals = new FakeApprovalSystem();
    audit = new AuditTrail(workDir);
    emitted = [];
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeGovernance(
    config: PythonStrategyGovernanceConfig,
  ): PythonStrategyGovernance {
    return new PythonStrategyGovernance(strategy, approvals, audit, healthyGate(), {
      ...config,
      emit: (event, payload) => {
        emitted.push({ event, payload });
      },
    });
  }

  it("fast-fails on the hard gate and audits a denied decision", async () => {
    const governance = makeGovernance(
      makeConfig({
        circuitState: { dailyLoss: true, weeklyLoss: false, marketCircuit: false, llmFailure: false },
      }),
    );

    const result = await governance.evaluateSignal(SIGNAL);

    expect(result.decision).toBe("reject");
    expect(result.reason).toMatch(/circuit breaker/i);
    expect(strategy.riskCheck).not.toHaveBeenCalled();

    const events = await audit.getEvents({ type: "decision", result: "denied" });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("hard_gate_rejected");
    expect((events[0]!.details as Record<string, unknown>)["sessionId"]).toBe("session-1");
    expect(emitted.map((entry) => entry.event)).toEqual(["strategy.gate_denied"]);
  });

  it("rejects when the Python risk gate denies and audits the decision", async () => {
    strategy.riskGate = { approved: false, reason: "position too large", suggested_size: 0 };
    const governance = makeGovernance(makeConfig());

    const result = await governance.evaluateSignal(SIGNAL);

    expect(result.decision).toBe("reject");
    expect(result.reason).toBe("position too large");
    expect(result.riskGate?.approved).toBe(false);
    expect(strategy.riskCheck).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTCUSDT", action: "buy" }),
      0.05,
      0.02,
    );
    expect(approvals.requiresApproval).not.toHaveBeenCalled();

    const events = await audit.getEvents({ type: "decision", result: "denied" });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("python_risk_rejected");
    expect(emitted.map((entry) => entry.event)).toEqual(["strategy.gate_denied"]);
  });

  it("creates an approval request and audits a pending decision when approval is required", async () => {
    approvals.required = true;
    const governance = makeGovernance(
      makeConfig({ approvalPriority: "high", maxPositionNotional: 50_000 }),
    );

    const result = await governance.evaluateSignal(SIGNAL);

    expect(result.decision).toBe("approval_required");
    expect(result.approvalRequestId).toBe("approval-1");
    expect(approvals.requiresApproval).toHaveBeenCalledWith(
      "strategy",
      "high",
      expect.objectContaining({ symbol: "BTCUSDT", maxPositionNotional: 50_000, sessionId: "session-1" }),
    );
    expect(approvals.createRequest).toHaveBeenCalledWith(
      "strategy",
      "BTCUSDT",
      "BTCUSDT",
      expect.stringContaining("buy"),
      "strategy-bot",
      "high",
      expect.anything(),
    );

    const events = await audit.getEvents({ type: "decision", result: "pending" });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("approval_required");
    expect(emitted.map((entry) => entry.event)).toEqual(["strategy.approval_required"]);
  });

  it("denies with an audit entry when approval routing fails", async () => {
    approvals.required = true;
    approvals.createRequest.mockRejectedValue(new Error("no approvers configured"));
    const governance = makeGovernance(makeConfig());

    const result = await governance.evaluateSignal(SIGNAL);

    expect(result.decision).toBe("reject");
    expect(result.reason).toBe("no approvers configured");

    const events = await audit.getEvents({ type: "decision", result: "denied" });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("approval_unavailable");
    expect(emitted.map((entry) => entry.event)).toEqual(["strategy.gate_denied"]);
  });

  it("audits an approved decision and emits strategy.executable when no approval is required", async () => {
    approvals.required = false;
    const governance = makeGovernance(makeConfig());

    const result = await governance.evaluateSignal(SIGNAL);

    expect(result.decision).toBe("execute");
    expect(result.riskGate?.approved).toBe(true);
    expect(approvals.requiresApproval).toHaveBeenCalledWith("strategy", "medium", expect.anything());
    expect(approvals.createRequest).not.toHaveBeenCalled();

    const events = await audit.getEvents({ type: "decision", result: "approved" });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("risks_accepted");
    const details = events[0]!.details as Record<string, unknown>;
    expect(details["sessionId"]).toBe("session-1");
    expect(details["symbol"]).toBe("BTCUSDT");
    expect(emitted.map((entry) => entry.event)).toEqual(["strategy.executable"]);
  });
});