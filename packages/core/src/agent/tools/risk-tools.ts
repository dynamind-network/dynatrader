/**
 * Agent Risk Tools
 *
 * Tool-calling surface for the agent's own risk management:
 * - halt_trading / resume_trading: persistent halt state (enforced by ExecutionRouter)
 * - trading_halt_status: read-only check of current halt state
 *
 * These are tools the model invokes deliberately — not a hidden gate layer.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import type {
  ToolDefinition,
  ToolHandler,
  ToolResult,
  ToolCall,
} from "../../types/index.js";
import { HaltState, type HaltScope, type HaltRecord } from "../../runtime/halt/halt-state";
import { CircuitState } from "../../runtime/risk/circuit-state";

export interface RiskToolsConfig {
  /** Workspace path; halt state persists under {workspacePath}/state/halt.json */
  workspacePath: string;
}

function resolveStateDir(workspacePath: string): string {
  const dir = join(workspacePath, "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function result(data: Record<string, unknown>): ToolResult {
  return { success: true, data, durationMs: 0, truncated: false };
}

export class HaltTradingTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: "halt_trading",
    description:
      "KILL SWITCH — immediately block all new order executions (or only a specific symbol). Persistent across restarts. Use when you detect dangerous conditions, runaway losses, or on explicit operator instruction.",
    category: "execution",
    inputSchema: {
      reason: "string",
      scope: "string? ('global' | symbol like BTC/USDT)",
    },
    timeoutMs: 5_000,
    riskLevel: "high",
    sideEffects: ["blocks all order execution until resumed"],
  };

  private halts: HaltState;

  constructor(config: RiskToolsConfig) {
    this.halts = new HaltState(resolveStateDir(config.workspacePath));
  }

  getHaltState(): HaltState {
    return this.halts;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const reason = typeof call.args.reason === "string" && call.args.reason.trim()
      ? call.args.reason.trim()
      : "Manual halt via agent risk tool";
    const rawScope = typeof call.args.scope === "string" ? call.args.scope.trim() : "";
    const scope: HaltScope = !rawScope || rawScope.toLowerCase() === "global" ? "global" : { symbol: rawScope };

    const record = this.halts.halt(reason, "agent", scope);
    return result({
      halted: true,
      scope: record.scope === "global" ? "global" : record.scope.symbol,
      reason: record.reason,
      id: record.id,
      message:
        record.scope === "global"
          ? "ALL trading is now halted. No orders will execute until resume_trading is called."
          : `Trading halted for ${record.scope.symbol}.`,
    });
  }
}

export class ResumeTradingTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: "resume_trading",
    description:
      "Lift a trading halt — re-enables order execution globally or for a specific symbol.",
    category: "execution",
    inputSchema: {
      scope: "string? ('global' | symbol). Omit to lift ALL halts.",
    },
    timeoutMs: 5_000,
  };

  private halts: HaltState;

  constructor(config: RiskToolsConfig) {
    this.halts = new HaltState(resolveStateDir(config.workspacePath));
  }

  getHaltState(): HaltState {
    return this.halts;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const rawScope = typeof call.args.scope === "string" ? call.args.scope.trim() : "";
    const scope: HaltScope | undefined =
      !rawScope || rawScope.toLowerCase() === "global" ? undefined : { symbol: rawScope };
    // Note: undefined scope here means "lift all", matching the tool description.
    if (!scope) {
      const lifted = this.halts.resume();
      return result({ resumed: true, liftedCount: lifted, message: `Lifted ${lifted} halt(s). Trading may resume.` });
    }
    const lifted = this.halts.resume(scope);
    return result({
      resumed: lifted > 0,
      liftedCount: lifted,
      message: lifted > 0 ? `Halt lifted for ${scope.symbol}.` : `No active halt found for ${scope.symbol}.`,
    });
  }
}

export class TradingHaltStatusTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: "trading_halt_status",
    description:
      "Check whether trading is currently halted (kill switch state) before sizing or submitting trades.",
    category: "analysis",
    inputSchema: {},
    timeoutMs: 5_000,
  };

  private halts: HaltState;

  constructor(config: RiskToolsConfig) {
    this.halts = new HaltState(resolveStateDir(config.workspacePath));
  }

  async execute(_call: ToolCall): Promise<ToolResult> {
    const records: HaltRecord[] = this.halts.list();
    return result({
      halted: records.length > 0,
      halts: records.map((r) => ({
        scope: r.scope === "global" ? "global" : r.scope.symbol,
        reason: r.reason,
        source: r.source,
        since: new Date(r.createdAt).toISOString(),
      })),
    });
  }
}

/**
 * Circuit-breaker visibility for the agent. Fed by execution outcomes
 * (see runtime-setup wiring); latches on daily-loss limit.
 */
export class CheckCircuitBreakersTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: "check_circuit_breakers",
    description:
      "Check daily loss / circuit-breaker status. Call this BEFORE sizing or submitting any trade: if tripped, do not trade — the kill switch should be engaged instead.",
    category: "analysis",
    inputSchema: {},
    timeoutMs: 5_000,
  };

  /** Shared singleton so recorded outcomes and queries see the same state. */
  static instances = new Map<string, CircuitState>();

  private circuit: CircuitState;

  constructor(config: RiskToolsConfig) {
    const key = config.workspacePath;
    let cs = CheckCircuitBreakersTool.instances.get(key);
    if (!cs) {
      const dailyLossLimitPct = parseFloat(
        process.env["DYNA_DAILY_LOSS_LIMIT_PCT"] ?? "0.05",
      );
      const autoResetMinutes = parseInt(process.env["DYNA_CIRCUIT_AUTO_RESET_MINUTES"] ?? "60", 10);
      cs = new CircuitState({ dailyLossLimitPct, autoResetMinutes });
      CheckCircuitBreakersTool.instances.set(key, cs);
    }
    this.circuit = cs;
  }

  /** Get the shared instance (for execution-outcome wiring). */
  static getFor(workspacePath: string): CircuitState {
    return new CheckCircuitBreakersTool({ workspacePath }).circuit;
  }

  async execute(_call: ToolCall): Promise<ToolResult> {
    const status = this.circuit.isTripped();
    return result({
      ...status,
      equity: this.circuit.equity,
      guidance: status.tripped
        ? "CIRCUIT BREAKER TRIPPED — do not place new orders. Engage halt_trading and wait for reset."
        : "Within limits — proceed with normal sizing discipline.",
    });
  }
}

export function createRiskTools(config: RiskToolsConfig): {
  haltTrading: HaltTradingTool;
  resumeTrading: ResumeTradingTool;
  haltStatus: TradingHaltStatusTool;
  circuitBreakers: CheckCircuitBreakersTool;
} {
  return {
    haltTrading: new HaltTradingTool(config),
    resumeTrading: new ResumeTradingTool(config),
    haltStatus: new TradingHaltStatusTool(config),
    circuitBreakers: new CheckCircuitBreakersTool(config),
  };
}
