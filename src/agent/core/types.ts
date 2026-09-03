/**
 * Core trading domain types.
 *
 * These types are shared across the agent core, memory, and learning systems.
 * Strategy logic is expressed as SKILL.md files — these types define the
 * data shapes the agent reasons about.
 */

import type { SkillManifest } from "@dyna/contracts";

export type MarketRegime = "trending" | "ranging" | "volatile" | "calm";
export type MarketTrend = "bullish" | "bearish" | "neutral";
export type VolumeLevel = "high" | "normal" | "low";
export type LearningType = "pattern" | "mistake" | "success" | "regime" | "timing";
export type LearningCategory = "entry" | "exit" | "risk" | "timing" | "regime";

export interface MarketConditions {
  regime: MarketRegime;
  volatility: number;
  trend: MarketTrend;
  volume: VolumeLevel;
}

export interface TradeOutcome {
  tradeId: string;
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  holdingTimeMs: number;
  strategy: SkillManifest;
  marketConditions: MarketConditions;
  timestamp: number;
}

export interface Learning {
  id: string;
  type: LearningType;
  content: string;
  confidence: number;
  evidence: string[];
  category: LearningCategory;
  applicableSymbols: string[];
  applicableRegimes: MarketRegime[];
  createdAt: number;
  lastUsedAt?: number;
  timesUsed: number;
  successRate: number;
}

export interface StrategyAdjustment {
  parameter: string;
  currentValue: unknown;
  suggestedValue: unknown;
  reason: string;
  confidence: number;
  basedOnTrades: number;
}

export interface LearningStats {
  totalLearnings: number;
  tradesAnalyzed: number;
  patternsFound: number;
  adjustmentsMade: number;
  averageConfidence: number;
  learningsByType: Record<LearningType, number>;
  learningsByCategory: Record<LearningCategory, number>;
}
