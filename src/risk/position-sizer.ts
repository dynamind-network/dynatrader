// ---------------------------------------------------------------------------
// Position Sizer (Nautilus pattern: Kelly + fixed-fraction + volatility-adjusted)
// ---------------------------------------------------------------------------

export interface PositionSizerConfig {
  maxPositionPct: number;
  minPositionPct: number;
  kellyFraction: number;
  maxLeverage: number;
}

export interface PositionSizeParams {
  equity: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  currentVolatility?: number;
  historicalVolatility?: number;
  riskPerTrade?: number;
}

export interface PositionSizeResult {
  size: number;
  sizePct: number;
  method: 'kelly' | 'fixed_fraction' | 'volatility_adjusted';
  leverage: number;
  riskAmount: number;
}

// ---------------------------------------------------------------------------
// Position Sizer Class
// ---------------------------------------------------------------------------

export class PositionSizer {
  private _config: PositionSizerConfig;

  constructor(config: PositionSizerConfig) {
    this._config = config;
  }

  // -- Kelly Criterion (quarter-Kelly for safety) --

  kelly(params: PositionSizeParams): PositionSizeResult {
    const { equity, winRate, avgWin, avgLoss } = params;

    if (avgLoss === 0 || winRate <= 0) {
      return { size: 0, sizePct: 0, method: 'kelly', leverage: 1, riskAmount: 0 };
    }

    const b = avgWin / avgLoss;
    const kellyPct = (winRate * b - (1 - winRate)) / b;
    const fraction = Math.max(0, kellyPct * this._config.kellyFraction);
    const sizePct = Math.min(fraction, this._config.maxPositionPct);
    const size = equity * sizePct;

    return {
      size,
      sizePct,
      method: 'kelly',
      leverage: 1,
      riskAmount: size * (1 - winRate),
    };
  }

  // -- Fixed Fraction --

  fixedFraction(params: PositionSizeParams, fraction: number): PositionSizeResult {
    const { equity } = params;
    const sizePct = Math.min(fraction, this._config.maxPositionPct);
    const size = equity * sizePct;

    return {
      size,
      sizePct,
      method: 'fixed_fraction',
      leverage: 1,
      riskAmount: size * (params.riskPerTrade || 0.02),
    };
  }

  // -- Volatility Adjusted --

  volatilityAdjusted(params: PositionSizeParams): PositionSizeResult {
    const { equity, currentVolatility, historicalVolatility, riskPerTrade = 0.02 } = params;
    const vol = currentVolatility || historicalVolatility || 0.02;
    const targetRisk = equity * riskPerTrade;
    const size = targetRisk / vol;
    const sizePct = Math.min(size / equity, this._config.maxPositionPct);
    const adjustedSize = equity * sizePct;

    return {
      size: adjustedSize,
      sizePct,
      method: 'volatility_adjusted',
      leverage: 1,
      riskAmount: targetRisk,
    };
  }

  // -- Auto-select best method --

  calculate(params: PositionSizeParams): PositionSizeResult {
    const { winRate, avgWin, avgLoss, currentVolatility } = params;

    if (winRate > 0 && avgWin > 0 && avgLoss > 0) {
      return this.kelly(params);
    }

    if (currentVolatility) {
      return this.volatilityAdjusted(params);
    }

    return this.fixedFraction(params, 0.02);
  }

  // -- Validation --

  validate(size: number, equity: number): { valid: boolean; reason?: string } {
    const pct = size / equity;

    if (pct < this._config.minPositionPct) {
      return { valid: false, reason: `Size below minimum ${this._config.minPositionPct * 100}%` };
    }

    if (pct > this._config.maxPositionPct) {
      return { valid: false, reason: `Size above maximum ${this._config.maxPositionPct * 100}%` };
    }

    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

export const DEFAULT_POSITION_SIZER_CONFIG: PositionSizerConfig = {
  maxPositionPct: 0.1,
  minPositionPct: 0.001,
  kellyFraction: 0.25,
  maxLeverage: 1,
};
