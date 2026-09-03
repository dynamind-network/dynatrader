/**
 * Dyna-Trader Execution Router
 *
 * Routes order execution based on the specified ExecutionMode:
 *   - backtest   -> PaperEngine (requires loaded market data)
 *   - paper      -> PaperEngine.placeOrder() with risk evaluation
 *   - shadow     -> Returns execution decision but does NOT execute
 *   - micro_live -> CCXTAdapter with strict order-value caps + optional approval token
 *   - live       -> CCXTAdapter.placeOrder() with full policy checks + required approval token
 *
 * Every execution decision is recorded in the audit trail.
 */

import { v4 as uuidv4 } from "uuid";
import {
  type OrderIntent,
  type ExecutionResult,
  type ExecutionMode,
  type ApprovalToken,
  type TradeMode,
  type AgentTurnContext,
  type ExchangeAdapter,
} from "@dyna/contracts";
import { PaperEngine } from "@dyna/backtest";
import { AuditTrail } from "@dyna/audit";
import { HaltState } from "../halt/halt-state";
import type { DEXAdapter } from "../../wallet/dex-adapters/adapter.interface";
import type { TxPipeline } from "../../wallet/tx-pipeline";
import type { WalletManager } from "../../wallet/wallet-manager";
import { SupportedChainId } from "../../wallet/types";
import type { TradeRecord } from "@dyna/backtest";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExecutionRouterConfig {
  /** Master switch for live (real-money) trading */
  liveTradingEnabled: boolean;
  /** Master switch for micro-live trading */
  microLiveEnabled: boolean;
  /** If true, live orders require a valid ApprovalToken */
  requireApprovalForLive: boolean;
  /** Maximum notional value (quote currency) for a single micro-live order */
  maxMicroLiveOrderValue: number;
  /** Whether paper trading mode is enabled. Defaults to true. */
  paperTradingEnabled?: boolean;
  /** Audit trail instance for recording all execution decisions */
  audit: AuditTrail;
  /** Paper engine for backtest and paper mode execution */
  paperEngine?: PaperEngine;
  /** Optional callback invoked after successful executions complete. */
  onExecution?: (event: ExecutionEvent) => Promise<void> | void;
  /** Backward-compatible alias for `onExecution`. */
  onPaperExecution?: (event: ExecutionEvent) => Promise<void> | void;
  /** Map of venue -> ExchangeAdapter for live / micro_live execution */
  exchangeAdapters?: Map<string, ExchangeAdapter>;
  /** DEX adapters for on-chain trading */
  dexAdapters?: Map<string, DEXAdapter>;
  /** Transaction pipeline for DEX swaps */
  txPipeline?: TxPipeline;
  /** Wallet manager for on-chain operations */
  walletManager?: WalletManager;
  /** Persistent kill-switch state; when halted, all matching executions are rejected */
  haltState?: HaltState;
}

export interface ExecutionEvent {
  intent: OrderIntent;
  trade: TradeRecord;
  executionMode: "backtest" | "paper" | "micro_live" | "live";
  result: ExecutionResult;
}

export type PaperExecutionEvent = ExecutionEvent;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ExecutionRouterImpl {
  private config: ExecutionRouterConfig;
  private executions: Map<string, ExecutionResult> = new Map();
  /** Tracks which engine handled each order for proper cancellation routing */
  private orderEngines: Map<string, "paper" | "exchange"> = new Map();
  private executionObserver: ExecutionRouterConfig["onExecution"] | null;

  constructor(config: ExecutionRouterConfig) {
    this.config = {
      paperTradingEnabled: true,
      ...config,
    };
    this.executionObserver = config.onExecution ?? config.onPaperExecution ?? null;
  }

  setExecutionObserver(observer?: ExecutionRouterConfig["onExecution"]): void {
    this.executionObserver = observer ?? null;
  }

  setPaperExecutionObserver(observer?: ExecutionRouterConfig["onExecution"]): void {
    this.setExecutionObserver(observer);
  }

  /**
   * Execute an order intent under the given execution mode.
   *
   * @param intent       The order to execute.
   * @param executionMode  The execution mode that determines how the order is handled.
   * @param approvalToken  Optional ApprovalToken required for live / micro_live modes.
   */
  async execute(
    intent: OrderIntent,
    executionMode: ExecutionMode,
    approvalToken?: ApprovalToken,
  ): Promise<ExecutionResult> {
    // 1. Validate mode transition
    const transitionError = this.validateModeTransition(executionMode);
    if (transitionError) {
      return this.recordRejection(intent, transitionError, executionMode);
    }

    // 1b. Kill switch: reject if halted globally or for this symbol
    const halts = this.config.haltState?.check(intent.symbol) ?? [];
    if (halts.length > 0) {
      return this.recordRejection(
        intent,
        `HALTED: ${halts.map((h) => `${h.scope === "global" ? "global" : h.scope.symbol} — ${h.reason} (via ${h.source})`).join("; ")}`,
        executionMode,
      );
    }

    // 2. Dispatch based on execution mode
    switch (executionMode) {
      case "backtest":
        return this.executeBacktest(intent);
      case "paper":
        return this.executePaper(intent);
      case "shadow":
        return this.executeShadow(intent);
      case "micro_live":
        return this.executeMicroLive(intent, approvalToken);
      case "live":
        return this.executeLive(intent, approvalToken);
      default:
        throw new Error(`Unknown execution mode: ${executionMode}`);
    }
  }

  /**
   * Retrieve the stored execution result for a given order ID.
   */
  async getStatus(orderId: string): Promise<ExecutionResult | null> {
    return this.executions.get(orderId) ?? null;
  }

  /**
   * Cancel an open order by delegating to the appropriate engine/adapter.
   * Routes to the correct engine based on which engine handled the order.
   */
  async cancel(orderId: string, symbol: string): Promise<void> {
    // Check which engine handled this order
    const engine = this.orderEngines.get(orderId);

    if (engine === "paper") {
      // Paper-engine orders
      if (!this.config.paperEngine) {
        throw new Error(`Paper engine not configured, cannot cancel order ${orderId}`);
      }
      await this.config.paperEngine.cancelOrder(orderId);
      return;
    }

    if (engine === "exchange") {
      // Exchange orders - find the right adapter by venue
      if (!this.config.exchangeAdapters || this.config.exchangeAdapters.size === 0) {
        throw new Error(`No exchange adapters configured, cannot cancel order ${orderId}`);
      }
      // Try to find the correct adapter by iterating all
      for (const adapter of this.config.exchangeAdapters.values()) {
        try {
          await adapter.cancelOrder({ orderId, symbol });
          return;
        } catch {
          // Try next adapter
        }
      }
      throw new Error(`Could not cancel exchange order ${orderId} on symbol ${symbol}`);
    }

    // Unknown order - try all engines as fallback
    const errors: string[] = [];

    if (this.config.paperEngine) {
      try {
        await this.config.paperEngine.cancelOrder(orderId);
        return;
      } catch (e) {
        errors.push(`paper: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (this.config.exchangeAdapters) {
      for (const adapter of this.config.exchangeAdapters.values()) {
        try {
          await adapter.cancelOrder({ orderId, symbol });
          return;
        } catch (e) {
          errors.push(`exchange: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    throw new Error(
      `Could not cancel order ${orderId}: no suitable engine found. Attempted: ${errors.join("; ")}`,
    );
  }

  // -----------------------------------------------------------------------
  // Private dispatch helpers
  // -----------------------------------------------------------------------

  private async executeBacktest(intent: OrderIntent): Promise<ExecutionResult> {
    if (!this.config.paperEngine) {
      return this.recordRejection(intent, "Paper engine not configured for backtest", "backtest");
    }

    try {
      const trade = await this.config.paperEngine.placeOrder(intent);
      const executionResult = await this.recordExecution(intent, {
        orderId: trade.id,
        status: trade.status === "filled" ? "filled" : "rejected",
        trade: {
          symbol: trade.symbol,
          side: trade.side,
          quantity: trade.quantity,
          price: trade.price,
          value: trade.value,
          fees: trade.fees,
        },
        ...(trade.reason ? { rejectionReason: trade.reason } : {}),
        timestamp: trade.timestamp,
      });
      this.orderEngines.set(trade.id, "paper");
      await this.notifyExecution({
        intent,
        trade,
        executionMode: "backtest",
        result: executionResult,
      });
      return executionResult;
    } catch (error) {
      return this.recordRejection(
        intent,
        `Backtest execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "backtest",
      );
    }
  }

  private async executePaper(intent: OrderIntent): Promise<ExecutionResult> {
    if (!this.config.paperEngine) {
      return this.recordRejection(intent, "Paper engine not configured", "paper");
    }

    try {
      const trade = await this.config.paperEngine.placeOrder(intent);
      const executionResult = await this.recordExecution(intent, {
        orderId: trade.id,
        status: trade.status === "filled" ? "filled" : "rejected",
        trade: {
          symbol: trade.symbol,
          side: trade.side,
          quantity: trade.quantity,
          price: trade.price,
          value: trade.value,
          fees: trade.fees,
        },
        ...(trade.reason ? { rejectionReason: trade.reason } : {}),
        timestamp: trade.timestamp,
      });
      this.orderEngines.set(trade.id, "paper");
      await this.notifyExecution({
        intent,
        trade,
        executionMode: "paper",
        result: executionResult,
      });
      return executionResult;
    } catch (error) {
      return this.recordRejection(
        intent,
        `Paper execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "paper",
      );
    }
  }

  private async notifyExecution(event: ExecutionEvent): Promise<void> {
    if (!this.executionObserver) {
      return;
    }

    try {
      await this.executionObserver(event);
    } catch {
      // Learning should never break execution routing.
    }
  }

  private async executeShadow(intent: OrderIntent): Promise<ExecutionResult> {
    // Shadow mode: evaluate what WOULD happen but don't execute.
    // Returns a "filled" status with an estimated trade.
    const estimatedPrice = intent.price ?? 0;
    const estimatedValue = intent.quantity * estimatedPrice;
    const estimatedFees = estimatedValue * 0.001; // 0.1% assumed fee

    return this.recordExecution(intent, {
      orderId: `shadow-${uuidv4()}`,
      status: "filled",
      trade: {
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        price: estimatedPrice,
        value: estimatedValue,
        fees: estimatedFees,
      },
      timestamp: new Date(),
    });
  }

  private async executeMicroLive(
    intent: OrderIntent,
    approvalToken?: ApprovalToken,
  ): Promise<ExecutionResult> {
    if (!this.config.microLiveEnabled) {
      return this.recordRejection(intent, "Micro-live trading is not enabled", "micro_live");
    }

    // Validate order value against micro-live cap.
    // A market order without a price would compute $0 notional and bypass the
    // cap entirely — reject unpriced intents rather than guessing.
    if (intent.price === undefined || intent.price === null) {
      return this.recordRejection(
        intent,
        "Micro-live orders require an explicit price so the notional cap can be enforced",
        "micro_live",
      );
    }
    const orderValue = intent.quantity * intent.price;
    if (orderValue > this.config.maxMicroLiveOrderValue) {
      return this.recordRejection(
        intent,
        `Order value $${orderValue.toFixed(2)} exceeds micro-live cap of $${this.config.maxMicroLiveOrderValue.toFixed(2)}`,
        "micro_live",
      );
    }

    // Require approval token if configured
    if (this.config.requireApprovalForLive && !approvalToken) {
      return this.recordRejection(
        intent,
        "Approval token required for micro_live execution",
        "micro_live",
      );
    }

    return this.executeOnExchange(intent, "micro_live");
  }

  private async executeLive(
    intent: OrderIntent,
    approvalToken?: ApprovalToken,
  ): Promise<ExecutionResult> {
    if (!this.config.liveTradingEnabled) {
      return this.recordRejection(intent, "Live trading is not enabled", "live");
    }

    // Require approval token for live orders
    if (this.config.requireApprovalForLive) {
      if (!approvalToken) {
        return this.recordRejection(
          intent,
          "Approval token is required for live order execution",
          "live",
        );
      }
      if (approvalToken.used || new Date() > approvalToken.expiresAt) {
        return this.recordRejection(
          intent,
          "Approval token is expired or already used",
          "live",
        );
      }
    }

    return this.executeOnExchange(intent, "live");
  }

  private async executeOnExchange(
    intent: OrderIntent,
    mode: "micro_live" | "live",
  ): Promise<ExecutionResult> {
    const adapter = this.config.exchangeAdapters?.get(intent.venue);
    if (!adapter) {
      return this.recordRejection(
        intent,
        `Unsupported venue: ${intent.venue}. No exchange adapter configured.`,
        mode,
      );
    }

    try {
      const result = await adapter.placeOrder(intent);
      const executionResult = await this.recordExecution(intent, {
        orderId: result.orderId,
        status: "filled",
        trade: {
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          price: intent.price ?? 0,
          value: intent.quantity * (intent.price ?? 0),
          fees: 0, // CCXT doesn't always return fees at place time
        },
        timestamp: new Date(),
      });
      this.orderEngines.set(result.orderId, "exchange");
      await this.notifyExecution({
        intent,
        trade: {
          id: result.orderId,
          timestamp: executionResult.timestamp,
          venue: intent.venue,
          symbol: intent.symbol,
          side: intent.side,
          type: intent.type,
          quantity: intent.quantity,
          price: intent.price ?? 0,
          value: intent.quantity * (intent.price ?? 0),
          fees: 0,
          slippage: 0,
          status: "filled",
        },
        executionMode: mode,
        result: executionResult,
      });
      return executionResult;
    } catch (error) {
      return this.recordRejection(
        intent,
        `Exchange execution failed: ${error instanceof Error ? error.message : String(error)}`,
        mode,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  /**
   * Validate that the mode transition / execution mode is allowed by config.
   * Returns a rejection reason string, or null if the mode is allowed.
   */
  private validateModeTransition(mode: ExecutionMode): string | null {
    switch (mode) {
      case "backtest":
        return null; // Always allowed
      case "paper":
        if (!this.config.paperTradingEnabled) {
          return "Paper trading is not enabled. Mode transition not allowed.";
        }
        return null;
      case "shadow":
        return null; // Always allowed (no real execution)
      case "micro_live":
        if (!this.config.microLiveEnabled) {
          return "Micro-live trading is not enabled. Mode transition not allowed.";
        }
        return null;
      case "live":
        if (!this.config.liveTradingEnabled) {
          return "Live trading is not enabled. Mode transition not allowed.";
        }
        return null;
      default:
        return `Unknown execution mode: ${mode}`;
    }
  }

  // -----------------------------------------------------------------------
  // Recording & audit
  // -----------------------------------------------------------------------

  private async recordExecution(
    intent: OrderIntent,
    result: ExecutionResult,
  ): Promise<ExecutionResult> {
    this.executions.set(result.orderId, result);

    await this.config.audit.record({
      type: "execution",
      actor: "execution-router",
      actorType: "system",
      action: `execute_${intent.mode}_order`,
      resource: `orders/${result.orderId}`,
      result: result.status === "filled" ? "success" : "rejected",
      details: {
        orderId: result.orderId,
        intent: {
          venue: intent.venue,
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          price: intent.price,
          strategyId: intent.strategyId,
        },
        result,
      },
    });

    return result;
  }

  private async recordRejection(
    intent: OrderIntent,
    reason: string,
    mode: ExecutionMode,
  ): Promise<ExecutionResult> {
    const orderId = `rejected-${uuidv4()}`;
    const result: ExecutionResult = {
      orderId,
      status: "rejected",
      rejectionReason: reason,
      timestamp: new Date(),
    };
    this.executions.set(orderId, result);

    await this.config.audit.record({
      type: "execution",
      actor: "execution-router",
      actorType: "system",
      action: `reject_${mode}_order`,
      resource: `orders/${orderId}`,
      result: "rejected",
      details: {
        orderId,
        intent: {
          venue: intent.venue,
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          price: intent.price,
          strategyId: intent.strategyId,
          mode,
        },
        rejectionReason: reason,
      },
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private mapExecutionModeToTradeMode(mode: ExecutionMode): TradeMode {
    switch (mode) {
      case "backtest":
        return "backtest";
      case "paper":
      case "shadow":
        return "paper";
      case "micro_live":
      case "live":
        return "live";
    }
  }

  // -----------------------------------------------------------------------
  // DEX Execution
  // -----------------------------------------------------------------------

  /**
   * Execute an on-chain DEX swap.
   * Converts an OrderIntent into a swap through the configured DEX adapter.
   */
  async executeDEX(
    intent: OrderIntent,
    executionMode: ExecutionMode,
    options?: {
      dexName?: string;
      chainId?: SupportedChainId;
      slippageTolerance?: number;
      deadlineMinutes?: number;
    },
  ): Promise<ExecutionResult> {
    if (!this.config.dexAdapters || !this.config.txPipeline || !this.config.walletManager) {
      return this.recordRejection(
        intent,
        "DEX trading infrastructure not configured (missing dexAdapters, txPipeline, or walletManager)",
        executionMode,
      );
    }

    // Validate mode
    const transitionError = this.validateModeTransition(executionMode);
    if (transitionError) {
      return this.recordRejection(intent, transitionError, executionMode);
    }

    // Select DEX adapter
    const dexName = options?.dexName ?? "0x";
    const adapter = this.config.dexAdapters.get(dexName);
    if (!adapter) {
      return this.recordRejection(
        intent,
        `DEX adapter not found: ${dexName}. Available: ${Array.from(this.config.dexAdapters.keys()).join(", ")}`,
        executionMode,
      );
    }

    try {
      // Parse symbol to get token addresses (format: "TOKEN_IN/TOKEN_OUT")
      const [tokenInSymbol, tokenOutSymbol] = intent.symbol.split("/");
      if (!tokenInSymbol || !tokenOutSymbol) {
        return this.recordRejection(
          intent,
          `Invalid DEX symbol format: ${intent.symbol}. Expected "TOKEN_IN/TOKEN_OUT"`,
          executionMode,
        );
      }

      // For shadow mode, return estimated result without executing
      if (executionMode === "shadow") {
        return this.executeShadow(intent);
      }

      // Execute through the pipeline
      const chainId = (options?.chainId ?? SupportedChainId.ETHEREUM) as SupportedChainId;
      const result = await this.config.txPipeline.executeSwap(
        {
          chainId,
          tokenIn: tokenInSymbol as `0x${string}`,
          tokenOut: tokenOutSymbol as `0x${string}`,
          amountIn: String(intent.quantity),
          slippageTolerance: options?.slippageTolerance ?? 0.5,
          deadlineMinutes: options?.deadlineMinutes ?? 20,
        },
        adapter,
      );

      const executionResult = await this.recordExecution(intent, {
        orderId: result.txHash ?? `dex-${uuidv4()}`,
        status: result.success ? "filled" : "rejected",
        trade: result.success ? {
          symbol: intent.symbol,
          side: intent.side,
          quantity: intent.quantity,
          price: intent.price ?? 0,
          value: intent.quantity * (intent.price ?? 0),
          fees: 0,
        } : undefined,
        rejectionReason: result.error,
        timestamp: new Date(),
      });

      return executionResult;
    } catch (error) {
      return this.recordRejection(
        intent,
        `DEX execution failed: ${error instanceof Error ? error.message : String(error)}`,
        executionMode,
      );
    }
  }
}
