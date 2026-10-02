/**
 * Kelly Criterion Position Sizer
 *
 * Calculates position size using Kelly Criterion with quarter-Kelly
 * and hard caps to prevent over-concentration and catastrophic loss.
 *
 * Formula: Kelly% = W - (1-W)/R
 * Where: W = win rate, R = avg win / avg loss ratio
 *
 * Quarter-Kelly: divide by 4 for conservative sizing
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types & Zod Schemas
// ---------------------------------------------------------------------------

export const KellyConfigSchema = z.object({
  kellyFraction: z.number().min(0).max(1).describe("Fraction of Kelly to use (0.25 = quarter-Kelly)"),
  maxPositionPct: z.number().min(0).max(1).describe("Maximum position size as % of portfolio"),
  minPositionPct: z.number().min(0).max(1).describe("Minimum position size"),
  minKellyPct: z.number().min(0).max(1).describe("Minimum Kelly % to execute"),
  maxSectorExposure: z.number().min(0).max(1).describe("Maximum sector exposure"),
});

export type KellyConfig = z.infer<typeof KellyConfigSchema>;

export const PositionSizingRequestSchema = z.object({
  winRate: z.number().min(0).max(1).describe("Historical win rate (0-1)"),
  avgWin: z.number().min(0).describe("Average win multiplier (2 = 100% gain)"),
  avgLoss: z.number().min(0).describe("Average loss multiplier (1 = 100% loss)"),
  regime: z.enum(["trending_up", "trending_down", "ranging", "volatile"]).optional(),
});

export type PositionSizingRequest = z.infer<typeof PositionSizingRequestSchema>;

export interface PositionSizingResult {
  kellyPct: number;
  positionPct: number;
  approved: boolean;
  reason: string;
}

export interface HardCapsValidationResult {
  approved: boolean;
  positionPct: number;
  sectorPct: number;
  violations: string[];
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Calculate Kelly Criterion position size.
 *
 * @param request - Position sizing parameters
 * @param config - Kelly configuration
 * @returns Position sizing result with Kelly% and approved size
 */
export function calculateKellyPosition(
  request: PositionSizingRequest,
  config: KellyConfig,
): PositionSizingResult {
  const { winRate, avgWin, avgLoss } = request;

  // Calculate reward ratio (R)
  const rewardRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

  // Kelly Formula: K% = W - (1-W)/R
  const kellyRaw = winRate - (1 - winRate) / rewardRatio;

  // Convert to percentage (0-1 range)
  const kellyPct = Math.max(0, kellyRaw);

  // Apply Kelly fraction (quarter-Kelly for conservative sizing)
  const adjustedKelly = kellyPct * config.kellyFraction;

  // Apply regime adjustments (reduce in volatile markets)
  let regimeMultiplier = 1.0;
  if (request.regime === "volatile") {
    regimeMultiplier = 0.5;
  } else if (request.regime === "ranging") {
    regimeMultiplier = 0.75;
  }

  // Calculate final position percentage
  let positionPct = adjustedKelly * regimeMultiplier;

  // Enforce hard caps
  positionPct = Math.min(positionPct, config.maxPositionPct);
  positionPct = Math.max(positionPct, config.minPositionPct);

  // Determine if position is approved
  const minKelly = config.minKellyPct;
  const approved = kellyPct > minKelly;

  let reason: string;
  if (kellyPct <= minKelly) {
    reason = `Kelly% (${(kellyPct * 100).toFixed(2)}%) <= minKelly (${(minKelly * 100).toFixed(2)}%) - no positive edge`;
  } else if (request.regime === "volatile") {
    reason = `Volatile regime - reduced to ${(positionPct * 100).toFixed(2)}%`;
  } else {
    reason = `Quarter-Kelly: ${(positionPct * 100).toFixed(2)}% of portfolio (Kelly: ${(kellyPct * 100).toFixed(2)}%, W=${(winRate * 100).toFixed(1)}%, R=${rewardRatio.toFixed(2)})`;
  }

  return {
    kellyPct,
    positionPct,
    approved,
    reason,
  };
}

/**
 * Calculate position size in base currency from percentage.
 *
 * @param portfolioValue - Total portfolio value in base currency
 * @param positionPct - Position size as percentage (0-1)
 * @returns Position size in base currency
 */
export function calculatePositionAmount(
  portfolioValue: number,
  positionPct: number,
): number {
  return portfolioValue * positionPct;
}

/**
 * Validate position against hard caps.
 *
 * @param positionPct - Proposed position percentage
 * @param sectorPct - Current sector exposure
 * @param config - Kelly configuration
 * @returns Validation result with any violations
 */
export function validateHardCaps(
  positionPct: number,
  sectorPct: number,
  config: KellyConfig,
): HardCapsValidationResult {
  const violations: string[] = [];

  // Check position cap
  if (positionPct > config.maxPositionPct) {
    violations.push(
      `Position ${(positionPct * 100).toFixed(2)}% exceeds max ${(config.maxPositionPct * 100).toFixed(2)}%`,
    );
    positionPct = config.maxPositionPct;
  }

  // Check minimum position
  if (positionPct < config.minPositionPct) {
    violations.push(
      `Position ${(positionPct * 100).toFixed(2)}% below min ${(config.minPositionPct * 100).toFixed(2)}% - using minimum`,
    );
    positionPct = config.minPositionPct;
  }

  // Check sector exposure
  const newSectorPct = sectorPct + positionPct;
  if (newSectorPct > config.maxSectorExposure) {
    violations.push(
      `Sector exposure ${(newSectorPct * 100).toFixed(2)}% exceeds max ${(config.maxSectorExposure * 100).toFixed(2)}%`,
    );
    positionPct = Math.max(0, config.maxSectorExposure - sectorPct);
  }

  const approved = violations.filter((v) => v.includes("exceeds")).length === 0;

  return {
    approved,
    positionPct,
    sectorPct: sectorPct + positionPct,
    violations,
  };
}

/**
 * Calculate Kelly from historical trade data.
 *
 * @param trades - Array of trade results (positive = win, negative = loss)
 * @returns { winRate, avgWin, avgLoss, kellyPct }
 */
export function calculateKellyFromHistory(trades: number[]): {
  winRate: number;
  avgWin: number;
  avgLoss: number;
  kellyPct: number;
} {
  if (trades.length === 0) {
    return { winRate: 0.5, avgWin: 1, avgLoss: 1, kellyPct: 0 };
  }

  const wins = trades.filter((t) => t > 0);
  const losses = trades.filter((t) => t < 0);

  const winRate = wins.length / trades.length;
  const avgWin =
    wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 1;
  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
      : 1;

  // Calculate Kelly (quarter-Kelly)
  const rewardRatio = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kellyPct =
    Math.max(0, winRate - (1 - winRate) / rewardRatio) * 0.25;

  return { winRate, avgWin, avgLoss, kellyPct };
}
