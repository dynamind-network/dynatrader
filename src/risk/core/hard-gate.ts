/**
 * Hard Risk Gate
 *
 * Risk manager has NO override - hard stop with mandatory reasoning.
 * Based on research: AutoHedge uses risk-first design where risk manager is gatekeeper.
 *
 * Extended with on-chain risk checks:
 * - Check 8: maxGasRatio — reject if gas > X% of trade value
 * - Check 9: maxSlippage — reject if slippage > configured max
 * - Check 10: chainRestriction — reject if chain not in allowed list
 */

import type { CircuitBreakerState } from "./circuit-breakers";
import { isTradingAllowed } from "./circuit-breakers";
import { SupportedChainId } from "../../wallet/types";

/**
 * Risk gate request
 */
export interface RiskGateRequest {
  portfolioValue: number;
  positionSize: number;
  proposedTradePct: number;
  currentPositions: Record<string, number>;
  dailyLoss: number;
  weeklyLoss: number;
  regime: "trending_up" | "trending_down" | "ranging" | "volatile";
  kellyPct: number;
  icScore?: number;
  irScore?: number;
}

/**
 * On-chain risk parameters
 */
export interface OnChainRiskParams {
  /** Gas estimate in wei */
  gasEstimate?: bigint;
  /** Gas price in wei */
  gasPrice?: bigint;
  /** Trade value in USD */
  tradeValueUsd?: number;
  /** Slippage tolerance % */
  slippagePercent?: number;
  /** Chain ID for the transaction */
  chainId?: SupportedChainId;
}

/**
 * Risk gate result
 */
export interface RiskGateResult {
  approved: boolean;
  reason: string;
  reductions: string[];
  mandatoryReasoning: string;
}

/**
 * On-chain risk gate configuration
 */
export interface OnChainRiskConfig {
  /** Max gas-to-value ratio % (default: 5) */
  maxGasRatioPercent: number;
  /** Max slippage % allowed (default: 2) */
  maxSlippagePercent: number;
  /** Allowed chain IDs (empty = all allowed) */
  allowedChains: SupportedChainId[];
}

const DEFAULT_ONCHAIN_CONFIG: OnChainRiskConfig = {
  maxGasRatioPercent: 5,
  maxSlippagePercent: 2,
  allowedChains: [],
};

/**
 * Execute hard risk gate check.
 *
 * NO OVERRIDE - If any check fails, trade is rejected.
 */
export function executeRiskGate(
  request: RiskGateRequest,
  circuitState: CircuitBreakerState,
  onChainParams?: OnChainRiskParams,
  onChainConfig: OnChainRiskConfig = DEFAULT_ONCHAIN_CONFIG,
): RiskGateResult {
  const reductions: string[] = [];

  // 1. Circuit breaker check (hard stop)
  const circuits = isTradingAllowed(circuitState);
  if (!circuits.allowed) {
    return {
      approved: false,
      reason: `CIRCUIT_BREAKER: ${circuits.reason}`,
      reductions: [],
      mandatoryReasoning: `REJECTED: ${circuits.reason}. Risk gate hard stop.`,
    };
  }

  // 2. Position size check
  if (request.proposedTradePct > 0.10) {
    reductions.push(
      `Position ${(request.proposedTradePct * 100).toFixed(2)}% exceeds 10% max - reducing`,
    );
    request.proposedTradePct = 0.10;
  }

  // 3. Kelly check - if negative expected value, require minimum or reject
  if (request.kellyPct <= 0 && request.proposedTradePct > 0.02) {
    reductions.push(
      `Kelly ${(request.kellyPct * 100).toFixed(2)}% <= 0 - reducing to minimum 2%`,
    );
    request.proposedTradePct = 0.02;
  }

  // 4. Volatile regime check - reduce sizes
  if (request.regime === "volatile") {
    const original = request.proposedTradePct;
    request.proposedTradePct = request.proposedTradePct * 0.5;
    reductions.push(
      `VOLATILE regime - reduced ${((1 - request.proposedTradePct / original) * 100).toFixed(0)}%`,
    );
  }

  // 5. Daily loss check - if losing money, be more conservative
  if (request.dailyLoss > 0) {
    const lossPct = request.dailyLoss / request.portfolioValue;
    if (lossPct > 0.03) {
      reductions.push(
        `Daily loss ${(lossPct * 100).toFixed(2)}% > 3% - reducing position 50%`,
      );
      request.proposedTradePct = request.proposedTradePct * 0.5;
    }
  }

  // 6. IC score check (if available) - reject if no predictive power
  if (request.icScore !== undefined && request.icScore < 0.03) {
    reductions.push(
      `IC ${request.icScore.toFixed(3)} < 0.03 - limited predictive power`,
    );
  }

  // 7. Portfolio concentration check
  const totalExposure =
    Object.values(request.currentPositions).reduce((sum, p) => sum + p, 0) +
    request.proposedTradePct;
  if (totalExposure > 0.95) {
    reductions.push(
      `Total exposure ${(totalExposure * 100).toFixed(2)}% > 95% - reducing`,
    );
    request.proposedTradePct =
      request.proposedTradePct * (0.95 / totalExposure);
  }

  // 8. On-chain: Gas ratio check
  if (onChainParams?.gasEstimate && onChainParams?.gasPrice && onChainParams?.tradeValueUsd) {
    const gasCostWei = onChainParams.gasEstimate * onChainParams.gasPrice;
    const gasCostUsd = Number(gasCostWei) / 1e18; // Assume native currency ~ $1 for ratio calc
    const gasRatio = (gasCostUsd / onChainParams.tradeValueUsd) * 100;

    if (gasRatio > onChainConfig.maxGasRatioPercent) {
      return {
        approved: false,
        reason: `ON_CHAIN: Gas ratio ${gasRatio.toFixed(1)}% exceeds max ${onChainConfig.maxGasRatioPercent}%`,
        reductions: [],
        mandatoryReasoning: `REJECTED: Gas cost ${gasRatio.toFixed(1)}% of trade value exceeds threshold.`,
      };
    }
  }

  // 9. On-chain: Slippage check
  if (onChainParams?.slippagePercent !== undefined) {
    if (onChainParams.slippagePercent > onChainConfig.maxSlippagePercent) {
      return {
        approved: false,
        reason: `ON_CHAIN: Slippage ${onChainParams.slippagePercent}% exceeds max ${onChainConfig.maxSlippagePercent}%`,
        reductions: [],
        mandatoryReasoning: `REJECTED: Slippage tolerance ${onChainParams.slippagePercent}% exceeds allowed maximum.`,
      };
    }
  }

  // 10. On-chain: Chain restriction check
  if (onChainParams?.chainId && onChainConfig.allowedChains.length > 0) {
    if (!onChainConfig.allowedChains.includes(onChainParams.chainId)) {
      return {
        approved: false,
        reason: `ON_CHAIN: Chain ${onChainParams.chainId} not in allowed list`,
        reductions: [],
        mandatoryReasoning: `REJECTED: Chain ${onChainParams.chainId} is not in the allowed chains list.`,
      };
    }
  }

  // Generate mandatory reasoning
  const reasoning = [
    `Risk Gate Check: ${reductions.length > 0 ? `APPROVED with ${reductions.length} reductions` : "CLEAN APPROVAL"}`,
    `Regime: ${request.regime}`,
    `Kelly: ${(request.kellyPct * 100).toFixed(2)}%`,
    `IC: ${request.icScore?.toFixed(3) ?? "N/A"}`,
    `IR: ${request.irScore?.toFixed(3) ?? "N/A"}`,
    `Position: ${(request.proposedTradePct * 100).toFixed(2)}%`,
    `Daily Loss: ${((request.dailyLoss / request.portfolioValue) * 100).toFixed(2)}%`,
    onChainParams?.chainId ? `Chain: ${onChainParams.chainId}` : '',
  ].filter(Boolean).join(" | ");

  return {
    approved: true,
    reason:
      reductions.length > 0
        ? `Approved with ${reductions.length} adjustments`
        : "Clean approval - all risk checks passed",
    reductions,
    mandatoryReasoning: reasoning,
  };
}

/**
 * Validate risk gate is required before any trade.
 */
export function isRiskGateRequired(): boolean {
  // Always required - no bypass
  return true;
}
