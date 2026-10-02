/**
 * DynaMind API — Risk Provider
 *
 * Wraps the DynaMind Data API's risk endpoints as a RiskProvider.
 * Provides: trade evaluation, circuit breaker config.
 *
 * NOTE: This provider calls the DynaMind API's risk evaluation endpoint
 * which uses their proprietary risk models. The core DynaTrader still
 * has a fallback hard-gate if the API is unavailable.
 */

import type {
  RiskProvider,
  RiskGateRequest,
  RiskGateResult,
  PluginCircuitBreakerConfig as CircuitBreakerConfig,
} from "@dyna/core";
import { requestDynaMindApi } from "./http.js";

export interface DynaMindRiskConfig {
  baseUrl: string;
  apiKey?: string;
  /** Fallback config if API is unavailable */
  fallbackConfig?: CircuitBreakerConfig;
}
const DEFAULT_FALLBACK_CONFIG: CircuitBreakerConfig = {
  dailyLossThreshold: 0.05,
  weeklyLossThreshold: 0.10,
  marketMoveThreshold: 0.10,
  llmFailureThreshold: 3,
  autoResetMinutes: 60,
};

export function createRiskProvider(config: DynaMindRiskConfig): RiskProvider {
  const fallback = config.fallbackConfig ?? DEFAULT_FALLBACK_CONFIG;

  return {
    async evaluateTrade(request: RiskGateRequest): Promise<RiskGateResult> {
      try {
        const data = await requestDynaMindApi<{
          approved: boolean;
          reason: string;
          reductions: string[];
          mandatory_reasoning: string;
        }>(config, "/api/v1/risk/evaluate", {
          method: "POST",
          body: request,
          timeoutMs: 5_000,
        });

        return {
          approved: data.approved,
          reason: data.reason,
          reductions: data.reductions ?? [],
          mandatoryReasoning: data.mandatory_reasoning,
        };
      } catch {
        // Fallback to local hard-gate logic if API unavailable
        return evaluateTradeLocally(request);
      }
    },

    getCircuitBreakerConfig(): CircuitBreakerConfig {
      return fallback;
    },
  };
}

/**
 * Local fallback risk evaluation (simplified version of hard-gate).
 * Used when the DynaMind API is unavailable.
 */
function evaluateTradeLocally(request: RiskGateRequest): RiskGateResult {
  const reductions: string[] = [];

  // Position size check
  if (request.proposedTradePct > 0.10) {
    return {
      approved: false,
      reason: `Position size ${request.proposedTradePct.toFixed(1)}% exceeds 10% max`,
      reductions: [],
      mandatoryReasoning: "REJECTED: Position size exceeds hard limit.",
    };
  }

  // Kelly negative
  if (request.kellyPct <= 0 && request.proposedTradePct > 0.02) {
    return {
      approved: false,
      reason: "Kelly criterion negative",
      reductions: [],
      mandatoryReasoning: "REJECTED: Kelly criterion is zero or negative.",
    };
  }

  // Volatile regime
  if (request.regime === "volatile") {
    reductions.push("Volatility regime: reduced by 50%");
  }

  // Daily loss
  const dailyLossPct = request.dailyLoss / request.portfolioValue;
  if (dailyLossPct > 0.03) {
    reductions.push(`Daily loss ${dailyLossPct.toFixed(1)}%: reduced by 50%`);
  }

  // Total exposure
  const totalExposure = Object.values(request.currentPositions)
    .reduce((sum, pos) => sum + Math.abs(pos), 0) / request.portfolioValue;
  if (totalExposure > 0.95) {
    return {
      approved: false,
      reason: `Total exposure ${(totalExposure * 100).toFixed(1)}% exceeds 95%`,
      reductions: [],
      mandatoryReasoning: "REJECTED: Total portfolio exposure exceeds limit.",
    };
  }

  return {
    approved: true,
    reason: "Approved via local fallback",
    reductions,
    mandatoryReasoning: "Evaluated by DynaTrader local fallback risk engine.",
  };
}
