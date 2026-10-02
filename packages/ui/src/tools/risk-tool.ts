/**
 * RiskTool — Risk management, position sizing, drawdown protection, portfolio rebalance
 *
 * Enforces risk limits at tool level. Called before every TradeTool.placeOrder().
 */

import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { getExchangeRegistry } from '../exchanges/registry.js';
import type { Position } from '../exchanges/registry.js';

export interface RiskLimits {
  maxPositionSizePct: number;
  maxDrawdownPct: number;
  maxLeverage: number;
  maxOpenPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxDailyLossPct: number;
  maxOrderSizeUsd: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  totalEquity: number;
  positions: Position[];
  peakEquity: number;
  currentDrawdownPct: number;
  dailyPnl: number;
}

const DEFAULT_LIMITS: RiskLimits = {
  maxPositionSizePct: 25,
  maxDrawdownPct: 20,
  maxLeverage: 10,
  maxOpenPositions: 10,
  stopLossPct: 5,
  takeProfitPct: 15,
  maxDailyLossPct: 10,
  maxOrderSizeUsd: 100_000,
};

export class RiskTool extends BaseTool {
  name = 'risk_manage';
  description = `Risk management: check_limits, set_limits, position_size, calculate_risk, rebalance, portfolio_stats.
Enforces max position size, max drawdown, leverage limits, and daily loss limits.`;
  isDestructive = false;
  riskLevel = 'medium' as const;

  private limits: RiskLimits = { ...DEFAULT_LIMITS };
  private peakEquity = 0;
  private dailyStartEquity = 0;
  private dailyStartDate = '';

  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Risk management action',
        enum: ['check_limits', 'set_limits', 'position_size', 'calculate_risk', 'rebalance', 'portfolio_stats'],
      },
      maxPositionSize: { type: 'number', description: 'Max % of portfolio per position' },
      maxDrawdown: { type: 'number', description: 'Max drawdown % before halt' },
      maxLeverage: { type: 'number', description: 'Max leverage allowed' },
      maxOpenPositions: { type: 'number', description: 'Max simultaneous positions' },
      stopLossPct: { type: 'number', description: 'Default stop loss %' },
      takeProfitPct: { type: 'number', description: 'Default take profit %' },
      maxDailyLossPct: { type: 'number', description: 'Max daily loss %' },
      maxOrderSizeUsd: { type: 'number', description: 'Max order size in USD' },
      orderSizeUsd: { type: 'number', description: 'Proposed order size in USD for position_size check' },
      winRate: { type: 'number', description: 'Historical win rate for Kelly (0-1)' },
      avgWin: { type: 'number', description: 'Average win size for Kelly' },
      avgLoss: { type: 'number', description: 'Average loss size for Kelly' },
      targetAllocation: { type: 'object', description: 'Target allocation { BTC: 0.4, ETH: 0.3 }' },
    },
    required: ['action'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const action = input.action as string;

    switch (action) {
      case 'check_limits':
        return this.checkLimits(input);
      case 'set_limits':
        return this.setLimits(input);
      case 'position_size':
        return this.positionSize(input);
      case 'calculate_risk':
        return this.calculateRisk(input);
      case 'rebalance':
        return this.rebalance(input);
      case 'portfolio_stats':
        return this.portfolioStats();
      default:
        return this.error(`Unknown action: ${action}`);
    }
  }

  private checkLimits(input: Record<string, unknown>): ToolResult {
    const sizeUsd = input.orderSizeUsd as number;
    const symbol = (input.symbol as string)?.toUpperCase();
    const side = input.side as string;
    const currentPositions = (input.currentPositions as number) || 0;
    const currentDrawdownPct = (input.currentDrawdownPct as number) || 0;
    const currentLeverage = (input.currentLeverage as number) || 1;

    const violations: string[] = [];

    if (currentDrawdownPct > this.limits.maxDrawdownPct) {
      violations.push(
        `Drawdown ${currentDrawdownPct.toFixed(2)}% exceeds max ${this.limits.maxDrawdownPct}%`
      );
    }

    if (currentPositions >= this.limits.maxOpenPositions) {
      violations.push(
        `Open positions ${currentPositions} at max ${this.limits.maxOpenPositions}`
      );
    }

    if (currentLeverage > this.limits.maxLeverage) {
      violations.push(
        `Leverage ${currentLeverage}x exceeds max ${this.limits.maxLeverage}x`
      );
    }

    if (typeof sizeUsd === 'number' && sizeUsd > this.limits.maxOrderSizeUsd) {
      violations.push(
        `Order size $${sizeUsd.toLocaleString()} exceeds max $${this.limits.maxOrderSizeUsd.toLocaleString()}`
      );
    }

    if (violations.length > 0) {
      return this.error(`Risk limit violations:\n${violations.map((v) => `  - ${v}`).join('\n')}\n\nTRADING HALTED`);
    }

    return this.success(
      `All risk limits within bounds.\n` +
        `  Max position size: ${this.limits.maxPositionSizePct}%\n` +
        `  Max drawdown: ${this.limits.maxDrawdownPct}%\n` +
        `  Max leverage: ${this.limits.maxLeverage}x\n` +
        `  Max open positions: ${this.limits.maxOpenPositions}\n` +
        `  Max daily loss: ${this.limits.maxDailyLossPct}%\n` +
        `  Max order size: $${this.limits.maxOrderSizeUsd.toLocaleString()}`
    );
  }

  private setLimits(input: Record<string, unknown>): ToolResult {
    if (typeof input.maxPositionSize === 'number') {
      this.limits.maxPositionSizePct = Math.max(1, Math.min(100, input.maxPositionSize));
    }
    if (typeof input.maxDrawdown === 'number') {
      this.limits.maxDrawdownPct = Math.max(1, Math.min(100, input.maxDrawdown));
    }
    if (typeof input.maxLeverage === 'number') {
      this.limits.maxLeverage = Math.max(1, Math.min(100, input.maxLeverage));
    }
    if (typeof input.maxOpenPositions === 'number') {
      this.limits.maxOpenPositions = Math.max(1, Math.min(50, input.maxOpenPositions));
    }
    if (typeof input.stopLossPct === 'number') {
      this.limits.stopLossPct = Math.max(0.1, Math.min(50, input.stopLossPct));
    }
    if (typeof input.takeProfitPct === 'number') {
      this.limits.takeProfitPct = Math.max(0.1, Math.min(100, input.takeProfitPct));
    }
    if (typeof input.maxDailyLossPct === 'number') {
      this.limits.maxDailyLossPct = Math.max(1, Math.min(50, input.maxDailyLossPct));
    }
    if (typeof input.maxOrderSizeUsd === 'number') {
      this.limits.maxOrderSizeUsd = Math.max(100, input.maxOrderSizeUsd);
    }

    return this.success(
      `Risk limits updated:\n` +
        `  Max position size: ${this.limits.maxPositionSizePct}%\n` +
        `  Max drawdown: ${this.limits.maxDrawdownPct}%\n` +
        `  Max leverage: ${this.limits.maxLeverage}x\n` +
        `  Max open positions: ${this.limits.maxOpenPositions}\n` +
        `  Stop loss: ${this.limits.stopLossPct}%\n` +
        `  Take profit: ${this.limits.takeProfitPct}%\n` +
        `  Max daily loss: ${this.limits.maxDailyLossPct}%\n` +
        `  Max order size: $${this.limits.maxOrderSizeUsd.toLocaleString()}`
    );
  }

  private positionSize(input: Record<string, unknown>): ToolResult {
    const equity = input.equity as number;
    const entryPrice = input.entryPrice as number;
    const stopPrice = input.stopPrice as number;
    const riskPct = (input.riskPct as number) || 2;

    if (!equity || equity <= 0) return this.error('equity must be positive');
    if (!entryPrice || entryPrice <= 0) return this.error('entryPrice must be positive');
    if (!stopPrice || stopPrice <= 0) return this.error('stopPrice must be positive');

    const riskPerUnit = Math.abs(entryPrice - stopPrice);
    if (riskPerUnit === 0) return this.error('entryPrice and stopPrice cannot be equal');

    const riskAmount = equity * (riskPct / 100);
    const positionSizeUnits = riskAmount / riskPerUnit;
    const positionSizeUsd = positionSizeUnits * entryPrice;
    const maxPositionUsd = equity * (this.limits.maxPositionSizePct / 100);

    const capped = positionSizeUsd > maxPositionUsd;
    const finalSizeUsd = capped ? maxPositionUsd : positionSizeUsd;
    const finalSizeUnits = finalSizeUsd / entryPrice;

    const stopLossPrice = entryPrice > stopPrice ? stopPrice : entryPrice + (entryPrice - stopPrice);
    const takeProfitPrice = entryPrice > stopPrice
      ? entryPrice + (entryPrice - stopPrice) * (this.limits.takeProfitPct / this.limits.stopLossPct)
      : entryPrice - (stopPrice - entryPrice) * (this.limits.takeProfitPct / this.limits.stopLossPct);

    return this.success(
      `Position sizing (${riskPct}% risk):\n` +
        `  Equity: $${equity.toLocaleString()}\n` +
        `  Risk amount: $${riskAmount.toFixed(2)}\n` +
        `  Entry: $${entryPrice.toFixed(2)}\n` +
        `  Stop: $${stopPrice.toFixed(2)}\n` +
        `  Position size: ${finalSizeUnits.toFixed(6)} units ($${finalSizeUsd.toFixed(2)})` +
        (capped ? ` [CAPPED at ${this.limits.maxPositionSizePct}% max]` : '') + '\n' +
        `  Stop loss: $${stopLossPrice.toFixed(2)}\n` +
        `  Take profit: $${takeProfitPrice.toFixed(2)}\n` +
        `  Risk/Reward: 1:${(this.limits.takeProfitPct / this.limits.stopLossPct).toFixed(1)}`
    );
  }

  private calculateRisk(input: Record<string, unknown>): ToolResult {
    const positions = (input.positions as Array<{
      symbol: string;
      size: number;
      entryPrice: number;
      currentPrice: number;
      leverage: number;
    }>) || [];

    if (positions.length === 0) {
      return this.success('No positions to analyze');
    }

    let totalUnrealizedPnl = 0;
    let totalNotional = 0;
    let totalMarginUsed = 0;

    const positionDetails = positions.map((pos) => {
      const pnl = (pos.currentPrice - pos.entryPrice) * pos.size;
      const notional = pos.currentPrice * pos.size;
      const margin = notional / pos.leverage;
      const pnlPct = (pnl / margin) * 100;

      totalUnrealizedPnl += pnl;
      totalNotional += notional;
      totalMarginUsed += margin;

      return {
        symbol: pos.symbol,
        pnl,
        notional,
        margin,
        pnlPct,
        contribution: 0,
      };
    });

    for (const pos of positionDetails) {
      pos.contribution = totalNotional > 0 ? (pos.notional / totalNotional) * 100 : 0;
    }

    const currentDrawdown = this.peakEquity > 0
      ? ((this.peakEquity - (this.peakEquity + totalUnrealizedPnl)) / this.peakEquity) * 100
      : 0;

    const lines = [
      `Portfolio Risk Analysis:`,
      `  Total notional: $${totalNotional.toFixed(2)}`,
      `  Total margin used: $${totalMarginUsed.toFixed(2)}`,
      `  Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`,
      `  Current drawdown: ${currentDrawdown.toFixed(2)}%`,
      '',
      'Positions:',
    ];

    for (const pos of positionDetails) {
      const sign = pos.pnl >= 0 ? '+' : '';
      lines.push(
        `  ${pos.symbol}: ${sign}$${pos.pnl.toFixed(2)} (${sign}${pos.pnlPct.toFixed(2)}%) | ${pos.contribution.toFixed(1)}% of portfolio`
      );
    }

    if (currentDrawdown > this.limits.maxDrawdownPct) {
      lines.push('', `WARNING: Drawdown exceeds ${this.limits.maxDrawdownPct}% limit! Consider reducing positions.`);
    }

    return this.success(lines.join('\n'));
  }

  private async rebalance(input: Record<string, unknown>): Promise<ToolResult> {
    const targetAllocation = input.targetAllocation as Record<string, number>;
    if (!targetAllocation || typeof targetAllocation !== 'object') {
      return this.error('targetAllocation is required (e.g., { "BTC": 0.4, "ETH": 0.3 })');
    }

    const totalTarget = Object.values(targetAllocation).reduce((a, b) => a + b, 0);
    if (Math.abs(totalTarget - 1) > 0.01) {
      return this.error(`Target allocation must sum to 1.0 (got ${totalTarget.toFixed(4)})`);
    }

    const registry = getExchangeRegistry();
    const adapter = registry.getDefaultAdapter();
    if (!adapter || !adapter.isConnected()) {
      return this.error('No default exchange connected');
    }

    const positions = await adapter.getPositions();
    const balance = await adapter.getBalance();

    const currentAllocation: Record<string, number> = {};
    const totalEquity = balance.total;

    for (const pos of positions) {
      const notional = pos.currentPrice * pos.size;
      currentAllocation[pos.symbol] = notional / totalEquity;
    }

    const lines = ['Rebalance analysis:', ''];

    for (const [symbol, targetPct] of Object.entries(targetAllocation)) {
      const currentPct = currentAllocation[symbol] || 0;
      const diff = targetPct - currentPct;
      const diffUsd = diff * totalEquity;

      const action = diff > 0.01 ? 'BUY' : diff < -0.01 ? 'SELL' : 'HOLD';
      lines.push(
        `  ${symbol}: ${(currentPct * 100).toFixed(1)}% -> ${(targetPct * 100).toFixed(1)}% | ` +
          `${action} $${Math.abs(diffUsd).toFixed(2)}`
      );
    }

    return this.success(lines.join('\n'));
  }

  private async portfolioStats(): Promise<ToolResult> {
    const registry = getExchangeRegistry();
    const adapter = registry.getDefaultAdapter();
    if (!adapter || !adapter.isConnected()) {
      return this.error('No default exchange connected');
    }

    const [positions, balance] = await Promise.all([
      adapter.getPositions(),
      adapter.getBalance(),
    ]);

    const totalEquity = balance.total;
    if (this.peakEquity === 0) this.peakEquity = totalEquity;
    if (totalEquity > this.peakEquity) this.peakEquity = totalEquity;

    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyStartDate !== today) {
      this.dailyStartDate = today;
      this.dailyStartEquity = totalEquity;
    }

    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const drawdownPct = this.peakEquity > 0
      ? ((this.peakEquity - totalEquity) / this.peakEquity) * 100
      : 0;
    const dailyPnlPct = this.dailyStartEquity > 0
      ? ((totalEquity - this.dailyStartEquity) / this.dailyStartEquity) * 100
      : 0;

    const lines = [
      `Portfolio Stats:`,
      `  Equity: $${totalEquity.toFixed(2)}`,
      `  Peak equity: $${this.peakEquity.toFixed(2)}`,
      `  Drawdown: ${drawdownPct.toFixed(2)}% (limit: ${this.limits.maxDrawdownPct}%)`,
      `  Daily PnL: ${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}% (limit: -${this.limits.maxDailyLossPct}%)`,
      `  Open positions: ${positions.length}/${this.limits.maxOpenPositions}`,
      `  Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`,
    ];

    if (drawdownPct > this.limits.maxDrawdownPct * 0.8) {
      lines.push('', `WARNING: Approaching max drawdown limit!`);
    }

    if (dailyPnlPct < -this.limits.maxDailyLossPct * 0.8) {
      lines.push('', `WARNING: Approaching max daily loss limit!`);
    }

    return this.success(lines.join('\n'));
  }
}

export default RiskTool;

