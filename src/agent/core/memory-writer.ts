/**
 * Memory Writer
 *
 * Persists agent decisions, trade outcomes, strategy evaluations, and risk
 * assessments. Maintains a decision journal the agent can review.
 */

import { randomUUID } from "node:crypto";
import type { SkillManifest } from "@dyna/contracts";
import type { MemoryStoreImpl } from "@dyna/memory-core";
import type { TradeOutcome, MarketConditions } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryEntryType =
  | "decision"
  | "outcome"
  | "evaluation"
  | "assessment"
  | "observation";

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  agentId: string;
  content: string;
  context: {
    symbol?: string;
    strategy?: string;
    riskLevel?: string;
    marketRegime?: string;
    confidence?: number;
  };
  metrics?: {
    pnl?: number;
    riskReward?: number;
    winRate?: number;
  };
  timestamp: number;
  importance: number;
  tags: string[];
}

export interface PerformanceSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
  averageWinPnl: number;
  averageLossPnl: number;
  profitFactor: number;
  largestWin: number;
  largestLoss: number;
  averageHoldingTimeMs: number;
  bestSymbol: string | null;
  worstSymbol: string | null;
  bestRegime: string | null;
  worstRegime: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_SCOPE = "memory_writer";
const JOURNAL_SCOPE = "decision_journal";
// ---------------------------------------------------------------------------
// Memory Writer
// ---------------------------------------------------------------------------

export class MemoryWriter {
  private memory: MemoryStoreImpl;
  private entries: Map<string, MemoryEntry> = new Map();

  constructor(memory: MemoryStoreImpl) {
    this.memory = memory;
  }

  /**
   * Record a trading decision.
   */
  async writeDecision(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<void> {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `decision-${randomUUID()}`,
      timestamp: Date.now(),
    };

    await this.commitDecision(fullEntry);
  }

  private async commitDecision(fullEntry: MemoryEntry): Promise<void> {
    this.entries.set(fullEntry.id, fullEntry);
    await this.memory.put({
      scope: JOURNAL_SCOPE,
      kind: "decision",
      payload: fullEntry,
      ts: new Date(fullEntry.timestamp),
    });

    // Also persist to general memory for searchability
    await this.memory.put({
      scope: MEMORY_SCOPE,
      kind: "decision",
      payload: fullEntry,
      ts: new Date(fullEntry.timestamp),
    });
  }

  /**
   * Record a trade outcome.
   */
  async writeOutcome(outcome: TradeOutcome): Promise<void> {
    const resultType = outcome.pnl > 0 ? "win" : outcome.pnl < 0 ? "loss" : "breakeven";

    const entry: Omit<MemoryEntry, "id" | "timestamp"> = {
      type: "outcome",
      agentId: "system",
      content: `${resultType.toUpperCase()} ${outcome.side} ${outcome.symbol}: PnL ${outcome.pnlPercent.toFixed(2)}% ($${outcome.pnl.toFixed(2)})`,
      context: {
        symbol: outcome.symbol,
        strategy: outcome.strategy.id,
        marketRegime: outcome.marketConditions.regime,
      },
      metrics: {
        pnl: outcome.pnl,
      },
      importance: Math.min(1, Math.abs(outcome.pnlPercent) * 5 + 0.3),
      tags: [resultType, outcome.side, outcome.symbol, outcome.marketConditions.regime],
    };

    const fullEntry: MemoryEntry = {
      ...entry,
      id: `outcome-${randomUUID()}`,
      timestamp: Date.now(),
    };

    await this.commitOutcome(fullEntry, outcome);
  }

  private async commitOutcome(fullEntry: MemoryEntry, outcome: TradeOutcome): Promise<void> {
    this.entries.set(fullEntry.id, fullEntry);
    await this.memory.put({
      scope: JOURNAL_SCOPE,
      kind: "outcome",
      payload: fullEntry,
      ts: new Date(fullEntry.timestamp),
    });

    await this.memory.put({
      scope: MEMORY_SCOPE,
      kind: "outcome",
      payload: {
        ...fullEntry,
        rawOutcome: {
          tradeId: outcome.tradeId,
          symbol: outcome.symbol,
          side: outcome.side,
          entryPrice: outcome.entryPrice,
          exitPrice: outcome.exitPrice,
          quantity: outcome.quantity,
          pnl: outcome.pnl,
          pnlPercent: outcome.pnlPercent,
          holdingTimeMs: outcome.holdingTimeMs,
        },
      },
      ts: new Date(fullEntry.timestamp),
    });
  }

  /**
   * Record a strategy evaluation.
   */
  async writeEvaluation(
    strategy: SkillManifest,
    evaluation: {
      analysis: string;
      confidence: number;
      riskScore: number;
      recommendations: string[];
    },
  ): Promise<void> {
    const entry: Omit<MemoryEntry, "id" | "timestamp"> = {
      type: "evaluation",
      agentId: "agent",
      content: evaluation.analysis,
      context: {
        symbol: strategy.symbol,
        strategy: strategy.id,
        confidence: evaluation.confidence,
      },
      metrics: {
        riskReward: evaluation.riskScore,
      },
      importance: evaluation.confidence,
      tags: ["evaluation", strategy.symbol, strategy.id],
    };

    const fullEntry: MemoryEntry = {
      ...entry,
      id: `eval-${randomUUID()}`,
      timestamp: Date.now(),
    };

    await this.commitEvaluation(fullEntry, evaluation);
  }

  private async commitEvaluation(
    fullEntry: MemoryEntry,
    evaluation: { analysis: string; confidence: number; riskScore: number; recommendations: string[] },
  ): Promise<void> {
    this.entries.set(fullEntry.id, fullEntry);
    await this.memory.put({
      scope: JOURNAL_SCOPE,
      kind: "evaluation",
      payload: {
        ...fullEntry,
        recommendations: evaluation.recommendations,
        riskScore: evaluation.riskScore,
      },
      ts: new Date(fullEntry.timestamp),
    });
  }

  /**
   * Record a risk assessment.
   */
  async writeAssessment(params: {
    strategyId: string;
    symbol: string;
    decision: string;
    reasons: string[];
    riskLevel: string;
    confidence: number;
  }): Promise<void> {
    const entry: Omit<MemoryEntry, "id" | "timestamp"> = {
      type: "assessment",
      agentId: "risk-engine",
      content: `Risk assessment for ${params.symbol}: ${params.decision} (${params.riskLevel}). Reasons: ${params.reasons.join("; ")}`,
      context: {
        symbol: params.symbol,
        strategy: params.strategyId,
        riskLevel: params.riskLevel,
        confidence: params.confidence,
      },
      importance: 0.6 + params.confidence * 0.4,
      tags: ["risk", params.decision, params.riskLevel, params.symbol],
    };

    const fullEntry: MemoryEntry = {
      ...entry,
      id: `risk-${randomUUID()}`,
      timestamp: Date.now(),
    };

    await this.commitAssessment(fullEntry);
  }

  private async commitAssessment(fullEntry: MemoryEntry): Promise<void> {
    this.entries.set(fullEntry.id, fullEntry);
    await this.memory.put({
      scope: JOURNAL_SCOPE,
      kind: "assessment",
      payload: fullEntry,
      ts: new Date(fullEntry.timestamp),
    });
  }

  /**
   * Record a general observation.
   */
  async writeObservation(params: {
    content: string;
    symbol?: string;
    importance?: number;
    tags?: string[];
  }): Promise<void> {
    const entry: Omit<MemoryEntry, "id" | "timestamp"> = {
      type: "observation",
      agentId: "agent",
      content: params.content,
      context: {
        symbol: params.symbol,
      },
      importance: params.importance ?? 0.5,
      tags: params.tags ?? ["observation"],
    };

    const fullEntry: MemoryEntry = {
      ...entry,
      id: `obs-${randomUUID()}`,
      timestamp: Date.now(),
    };

    await this.commitObservation(fullEntry);
  }

  private async commitObservation(fullEntry: MemoryEntry): Promise<void> {
    this.entries.set(fullEntry.id, fullEntry);
    await this.memory.put({
      scope: MEMORY_SCOPE,
      kind: "observation",
      payload: fullEntry,
      ts: new Date(fullEntry.timestamp),
    });
  }

  /**
   * Get decision history, optionally filtered by symbol.
   */
  async getDecisionHistory(
    symbol?: string,
    limit: number = 50,
  ): Promise<MemoryEntry[]> {
    // Load from memory if local map is empty
    if (this.entries.size === 0) {
      await this.loadPersistedEntries();
    }

    let entries = Array.from(this.entries.values());

    // Filter by symbol if provided
    if (symbol) {
      entries = entries.filter((e) => e.context.symbol === symbol);
    }

    // Sort by timestamp descending (most recent first)
    entries.sort((a, b) => b.timestamp - a.timestamp);

    return entries.slice(0, limit);
  }

  /**
   * Get aggregate performance summary from recorded outcomes.
   */
  async getPerformanceSummary(): Promise<PerformanceSummary> {
    const outcomes = Array.from(this.entries.values()).filter(
      (e) => e.type === "outcome",
    );

    if (outcomes.length === 0) {
      return this.emptyPerformanceSummary();
    }

    let totalPnl = 0;
    let winningPnl = 0;
    let losingPnl = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let largestWin = -Infinity;
    let largestLoss = Infinity;
    let totalHoldingMs = 0;
    let symbolPnl = new Map<string, number>();
    let regimePnl = new Map<string, number>();

    for (const outcome of outcomes) {
      const pnl = outcome.metrics?.pnl ?? 0;
      totalPnl += pnl;
      totalHoldingMs += (outcome.context as Record<string, unknown>).holdingTimeMs as number ?? 0;

      if (pnl > 0.001) {
        wins++;
        winningPnl += pnl;
        largestWin = Math.max(largestWin, pnl);
      } else if (pnl < -0.001) {
        losses++;
        losingPnl += pnl;
        largestLoss = Math.min(largestLoss, pnl);
      } else {
        breakeven++;
      }

      // Track per-symbol performance
      const symbol = outcome.context.symbol;
      if (symbol) {
        symbolPnl.set(symbol, (symbolPnl.get(symbol) ?? 0) + pnl);
      }

      // Track per-regime performance
      const regime = outcome.context.marketRegime;
      if (regime) {
        regimePnl.set(regime, (regimePnl.get(regime) ?? 0) + pnl);
      }
    }

    const totalTrades = outcomes.length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const averagePnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const averageWinPnl = wins > 0 ? winningPnl / wins : 0;
    const averageLossPnl = losses > 0 ? losingPnl / losses : 0;
    const profitFactor = losingPnl !== 0 ? Math.abs(winningPnl / losingPnl) : winningPnl > 0 ? Infinity : 0;

    // Find best/worst symbol
    let bestSymbol: string | null = null;
    let worstSymbol: string | null = null;
    let bestSymbolPnl = -Infinity;
    let worstSymbolPnl = Infinity;

    for (const [symbol, pnl] of symbolPnl) {
      if (pnl > bestSymbolPnl) {
        bestSymbolPnl = pnl;
        bestSymbol = symbol;
      }
      if (pnl < worstSymbolPnl) {
        worstSymbolPnl = pnl;
        worstSymbol = symbol;
      }
    }

    // Find best/worst regime
    let bestRegime: string | null = null;
    let worstRegime: string | null = null;
    let bestRegimePnl = -Infinity;
    let worstRegimePnl = Infinity;

    for (const [regime, pnl] of regimePnl) {
      if (pnl > bestRegimePnl) {
        bestRegimePnl = pnl;
        bestRegime = regime;
      }
      if (pnl < worstRegimePnl) {
        worstRegimePnl = pnl;
        worstRegime = regime;
      }
    }

    return {
      totalTrades,
      winningTrades: wins,
      losingTrades: losses,
      breakevenTrades: breakeven,
      winRate,
      totalPnl,
      averagePnl,
      averageWinPnl,
      averageLossPnl,
      profitFactor,
      largestWin: largestWin === -Infinity ? 0 : largestWin,
      largestLoss: largestLoss === Infinity ? 0 : largestLoss,
      averageHoldingTimeMs: totalTrades > 0 ? totalHoldingMs / totalTrades : 0,
      bestSymbol,
      worstSymbol,
      bestRegime,
      worstRegime,
    };
  }

  /**
   * Get all entries (for inspection / testing).
   */
  getAllEntries(): MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private emptyPerformanceSummary(): PerformanceSummary {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakevenTrades: 0,
      winRate: 0,
      totalPnl: 0,
      averagePnl: 0,
      averageWinPnl: 0,
      averageLossPnl: 0,
      profitFactor: 0,
      largestWin: 0,
      largestLoss: 0,
      averageHoldingTimeMs: 0,
      bestSymbol: null,
      worstSymbol: null,
      bestRegime: null,
      worstRegime: null,
    };
  }

  private async loadPersistedEntries(): Promise<void> {
    try {
      const results = await this.memory.search({
        scope: MEMORY_SCOPE,
        text: "decision outcome evaluation assessment",
        topK: 500,
      });

      for (const result of results) {
        const payload = result.payload as Record<string, unknown>;
        if (payload && typeof payload === "object" && "id" in payload) {
          const entry = payload as unknown as MemoryEntry;
          if (!this.entries.has(entry.id)) {
            this.entries.set(entry.id, entry);
          }
        }
      }
    } catch {
      // Memory may not have entries yet; that's fine
    }
  }

}
