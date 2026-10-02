/**
 * PythonStrategyGovernance
 *
 * Composes the `python.strategy` service with the hard risk gate, the
 * approval workflow, and the AuditTrail so a single
 * StrategySignal flows through the same governance pipeline used by every
 * other trading decision: synchronous fast-fail hard gate first, then the
 * Python risk assessment, then approval routing, then audit recording.
 *
 * Decisions emit `strategy.*` events onto the configured bus so they remain
 * consistent with the convention-coded forwarding already performed by the
 * kernel plugin.
 */

import type { PythonStrategyService } from "./strategy-plugin";
import type { RiskGate, StrategySignal } from "./strategy-bridge";
import type {
  CircuitBreakerState,
  RiskGateRequest,
  RiskGateResult,
} from "@dyna/risk-core";
import { executeRiskGate } from "@dyna/risk-core";
import { AuditTrail } from "@dyna/audit";
import type { AuditEvent } from "@dyna/audit";
import { eventBus } from "@dyna/event-bus";

/** Approval item types understood by the approval system. */
export type StrategyApprovalType = "strategy" | "order" | "position" | "system";

/** Approval priorities understood by the approval system. */
export type ApprovalPriority = "low" | "medium" | "high" | "critical";

/**
 * Minimal approval surface consumed by the governance gate.
 */
export interface StrategyApprovalSystem {
  requiresApproval(
    type: StrategyApprovalType,
    priority: ApprovalPriority,
    context?: unknown,
  ): boolean;
  createRequest(
    type: StrategyApprovalType,
    itemId: string,
    itemName: string,
    description: string,
    requester: string,
    priority: ApprovalPriority,
    context?: unknown,
  ): Promise<string>;
}

/** Hard-gate surface wrapping the pure executeRiskGate function. */
export interface HardGate {
  check(request: RiskGateRequest, circuitState: CircuitBreakerState): RiskGateResult;
}

/**
 * Default HardGate adapter delegating to the canonical executeRiskGate from
 * @dyna/risk-core without duplicating any gate logic.
 */
export class DefaultHardGate implements HardGate {
  check(request: RiskGateRequest, circuitState: CircuitBreakerState): RiskGateResult {
    return executeRiskGate(request, circuitState);
  }
}

/** Configuration for PythonStrategyGovernance. */
export interface PythonStrategyGovernanceConfig {
  /** Position size as a fraction of portfolio value. */
  positionSize: number;
  /** Maximum acceptable risk per trade as a fraction. */
  maxRisk: number;
  /** Portfolio value used by the hard gate. */
  portfolioValue: number;
  /** Market regime passed to the hard gate. */
  regime: RiskGateRequest["regime"];
  /** Circuit breaker state passed to the hard gate. */
  circuitState: CircuitBreakerState;
  /** Kelly fraction passed to the hard gate. Defaults to 0. */
  kellyPct?: number;
  /** IC score passed to the hard gate. */
  icScore?: number;
  /** IR score passed to the hard gate. */
  irScore?: number;
  /** Daily loss in currency units. Defaults to 0. */
  dailyLoss?: number;
  /** Weekly loss in currency units. Defaults to 0. */
  weeklyLoss?: number;
  /** Current position sizes keyed by symbol. Defaults to {}. */
  currentPositions?: Record<string, number>;
  /** Approval priority routed to the approval system. Defaults to "medium". */
  approvalPriority?: ApprovalPriority;
  /** Identity used as requester/actor for approvals and audit. */
  requester?: string;
  /** Max position notional used by auto-approve conditions. */
  maxPositionNotional?: number;
  /** Channel forwarded to approval routing. */
  channel?: string;
  /** Requester role forwarded to approval routing. */
  requesterRole?: string;
  /** Session id threaded through audit details and approval context. */
  sessionId?: string;
  /**
   * Optional event emitter for strategy.* events. Falls back to the
   * @dyna/event-bus singleton when omitted.
   */
  emit?: (event: string, payload?: unknown) => void | Promise<void>;
}

/** Outcome of evaluating a single strategy signal. */
export type StrategyEvaluationDecision = "execute" | "approval_required" | "reject";

/** Result of evaluating a single strategy signal. */
export interface StrategyEvaluation {
  decision: StrategyEvaluationDecision;
  reason: string;
  riskGate?: RiskGate;
  approvalRequestId?: string;
}

/**
 * Governance pipeline that grades a strategy signal through the hard gate,
 * the Python risk check and the configured approval system.
 */
export class PythonStrategyGovernance {
  private readonly strategy: PythonStrategyService;
  private readonly approvals: StrategyApprovalSystem;
  private readonly audit: AuditTrail;
  private readonly hardGate: HardGate;
  private readonly config: PythonStrategyGovernanceConfig;
  private readonly emitFn: (event: string, payload?: unknown) => void | Promise<void>;

  constructor(
    strategy: PythonStrategyService,
    approvals: StrategyApprovalSystem,
    audit: AuditTrail,
    hardGate: HardGate,
    config: PythonStrategyGovernanceConfig,
  ) {
    this.strategy = strategy;
    this.approvals = approvals;
    this.audit = audit;
    this.hardGate = hardGate;
    this.config = config;
    this.emitFn = config.emit ?? ((event, payload) => eventBus.emitDynamic(event, payload));
  }

  /**
   * Evaluate a strategy signal.
   *
   * 1. Synchronous fast-fail through the hard gate.
   * 2. Python riskCheck for the risk assessment.
   * 3. Denied results are audited (`decision` / `denied`) and rejected.
   * 4. Signals requiring approval create an approval request, audited as
   *    `pending`, and return `approval_required`.
   * 5. Otherwise the signal is audited as `approved` and returns `execute`.
   */
  async evaluateSignal(signal: StrategySignal): Promise<StrategyEvaluation> {
    const gateResult = this.hardGate.check(
      this.buildGateRequest(),
      this.config.circuitState,
    );
    if (!gateResult.approved) {
      const reason = gateResult.reason;
      await this.record("denied", "hard_gate_rejected", {
        ...this.baseDetails(),
        symbol: signal.symbol,
        reason,
      });
      void this.emitFn("strategy.gate_denied", {
        symbol: signal.symbol,
        reason,
        sessionId: this.config.sessionId,
      });
      return { decision: "reject", reason };
    }

    const riskGate = await this.strategy.riskCheck(
      { ...signal },
      this.config.positionSize,
      this.config.maxRisk,
    );

    if (!riskGate.approved) {
      const reason = riskGate.reason;
      await this.record("denied", "python_risk_rejected", {
        ...this.baseDetails(),
        symbol: signal.symbol,
        reason,
        suggestedSize: riskGate.suggested_size,
      });
      void this.emitFn("strategy.gate_denied", {
        symbol: signal.symbol,
        reason,
        sessionId: this.config.sessionId,
      });
      return { decision: "reject", reason, riskGate };
    }

    const context = this.buildApprovalContext(signal);
    if (this.approvals.requiresApproval("strategy", this.priority(), context)) {
      try {
        const requestId = await this.approvals.createRequest(
          "strategy",
          signal.symbol,
          signal.symbol,
          `${signal.action} ${signal.symbol} at confidence ${signal.confidence}`,
          this.config.requester ?? "python-strategy",
          this.priority(),
          context,
        );
        await this.record("pending", "approval_required", {
          ...this.baseDetails(),
          symbol: signal.symbol,
          reason: riskGate.reason,
          approvalRequestId: requestId,
        });
        void this.emitFn("strategy.approval_required", {
          symbol: signal.symbol,
          requestId,
          sessionId: this.config.sessionId,
        });
        return {
          decision: "approval_required",
          reason: riskGate.reason,
          riskGate,
          approvalRequestId: requestId,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.record("denied", "approval_unavailable", {
          ...this.baseDetails(),
          symbol: signal.symbol,
          reason,
        });
        void this.emitFn("strategy.gate_denied", {
          symbol: signal.symbol,
          reason,
          sessionId: this.config.sessionId,
        });
        return { decision: "reject", reason, riskGate };
      }
    }

    await this.record("approved", "risks_accepted", {
      ...this.baseDetails(),
      symbol: signal.symbol,
      reason: riskGate.reason,
      suggestedSize: riskGate.suggested_size,
    });
    void this.emitFn("strategy.executable", {
      symbol: signal.symbol,
      suggestedSize: riskGate.suggested_size,
      sessionId: this.config.sessionId,
    });
    return { decision: "execute", reason: riskGate.reason, riskGate };
  }

  private priority(): ApprovalPriority {
    return this.config.approvalPriority ?? "medium";
  }

  private buildGateRequest(): RiskGateRequest {
    return {
      portfolioValue: this.config.portfolioValue,
      positionSize: this.config.positionSize,
      proposedTradePct: this.config.positionSize,
      currentPositions: this.config.currentPositions ?? {},
      dailyLoss: this.config.dailyLoss ?? 0,
      weeklyLoss: this.config.weeklyLoss ?? 0,
      regime: this.config.regime,
      kellyPct: this.config.kellyPct ?? 0,
      icScore: this.config.icScore,
      irScore: this.config.irScore,
    };
  }

  private baseDetails(): Record<string, unknown> {
    const details: Record<string, unknown> = {
      positionSize: this.config.positionSize,
      maxRisk: this.config.maxRisk,
      requester: this.config.requester ?? "python-strategy",
    };
    if (this.config.sessionId !== undefined) {
      details["sessionId"] = this.config.sessionId;
    }
    return details;
  }

  private buildApprovalContext(signal: StrategySignal): Record<string, unknown> {
    const context: Record<string, unknown> = {
      symbol: signal.symbol,
      action: signal.action,
      channel: this.config.channel,
      requesterRole: this.config.requesterRole,
    };
    if (this.config.maxPositionNotional !== undefined) {
      context["maxPositionNotional"] = this.config.maxPositionNotional;
    }
    if (this.config.sessionId !== undefined) {
      context["sessionId"] = this.config.sessionId;
    }
    return context;
  }

  private async record(
    result: "approved" | "pending" | "denied",
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const event: Omit<AuditEvent, "id" | "timestamp"> = {
      type: "decision",
      actor: this.config.requester ?? "python-strategy",
      actorType: "system",
      action,
      resource: "strategy/signals",
      result,
      details,
    };
    await this.audit.record(event);
  }
}