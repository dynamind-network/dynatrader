/**
 * DynaMind API — Signal Provider
 *
 * Wraps the DynaMind Data API's AI signal endpoints as a SignalProvider.
 * Provides: trading signals, consensus signals, accuracy stats.
 */

import type {
  SignalProvider,
  Signal,
  ConsensusSignal,
  AccuracyStats,
} from "@dyna/core";
import { requestDynaMindApi } from "./http.js";

export interface DynaMindSignalConfig {
  baseUrl: string;
  apiKey?: string;
}
export function createSignalProvider(
  config: DynaMindSignalConfig,
): SignalProvider {
  async function request<T>(path: string): Promise<T> {
    return requestDynaMindApi<T>(config, path, { timeoutMs: 15_000 });
  }

  return {
    async getSignal(symbol: string): Promise<Signal> {
      const data = await request<{
        signal: {
          symbol: string;
          direction: string;
          tier: string;
          confidence: number;
          rationale: string;
          entry?: number;
          stop_loss?: number;
          take_profit?: number;
          risk_reward?: number;
          timeframe: string;
          timestamp: string;
        };
      }>(`/api/v1/signals/${encodeURIComponent(symbol)}`);

      return {
        symbol: data.signal.symbol,
        direction: data.signal.direction as Signal["direction"],
        tier: data.signal.tier as Signal["tier"],
        confidence: data.signal.confidence,
        rationale: data.signal.rationale,
        entry: data.signal.entry,
        stopLoss: data.signal.stop_loss,
        takeProfit: data.signal.take_profit,
        riskReward: data.signal.risk_reward,
        timeframe: data.signal.timeframe,
        timestamp: data.signal.timestamp,
      };
    },

    async getConsensus(symbol: string): Promise<ConsensusSignal> {
      const data = await request<{
        consensus: {
          symbol: string;
          direction: string;
          tier: string;
          confidence: number;
          timeframe_signals: Record<string, unknown>;
          weights: Record<string, number>;
        };
      }>(`/api/v1/signals/consensus/${encodeURIComponent(symbol)}`);

      return {
        symbol: data.consensus.symbol,
        direction: data.consensus.direction as ConsensusSignal["direction"],
        tier: data.consensus.tier as ConsensusSignal["tier"],
        confidence: data.consensus.confidence,
        timeframe_signals: data.consensus.timeframe_signals as ConsensusSignal["timeframe_signals"],
        weights: data.consensus.weights,
      };
    },

    async getAccuracy(): Promise<AccuracyStats> {
      const data = await request<{
        total_signals: number;
        correct_signals: number;
        accuracy: number;
        by_tier: Record<string, {
          total: number;
          correct: number;
          accuracy: number;
        }>;
      }>("/api/v1/signals/accuracy");

      const byTier: AccuracyStats["byTier"] = {
        STRONG: { total: 0, correct: 0, accuracy: 0 },
        MODERATE: { total: 0, correct: 0, accuracy: 0 },
        WEAK: { total: 0, correct: 0, accuracy: 0 },
      };

      for (const [tier, stats] of Object.entries(data.by_tier)) {
        if (tier in byTier) {
          byTier[tier as keyof typeof byTier] = {
            total: stats.total,
            correct: stats.correct,
            accuracy: stats.accuracy,
          };
        }
      }

      return {
        totalSignals: data.total_signals,
        correctSignals: data.correct_signals,
        accuracy: data.accuracy,
        byTier,
      };
    },
  };
}
