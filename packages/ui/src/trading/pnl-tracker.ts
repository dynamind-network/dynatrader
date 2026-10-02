/**
 * PnL Tracker — SQLite-backed time series PnL snapshots and trade journal
 *
 * Auto-snapshots every 5 minutes during active trading, records every trade
 * with rationale, and computes equity curve data.
 */

import { randomUUID } from 'crypto';
import type { StateDb } from '@dyna/core';
import { getExchangeRegistry } from '../exchanges/registry.js';

export interface PnlSnapshot {
  timestamp: number;
  totalValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: unknown;
}

export interface TradeRecord {
  id: string;
  timestamp: number;
  exchange: string;
  symbol: string;
  side: string;
  size: number;
  price: number;
  pnl?: number;
  fees?: number;
  strategy?: string;
  rationale?: string;
}

export interface EquityCurvePoint {
  timestamp: number;
  equity: number;
  drawdown: number;
}

export interface StrategyPnl {
  strategy: string;
  totalPnl: number;
  tradeCount: number;
  winRate: number;
  avgPnl: number;
  totalFees: number;
}

export interface DailyPnl {
  date: string;
  pnl: number;
  tradeCount: number;
  winRate: number;
}

export class PnlTracker {
  private db: StateDb;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private peakEquity = 0;
  private sessionId: string;

  constructor(db: StateDb, sessionId?: string) {
    this.db = db;
    this.sessionId = sessionId || 'default';
  }

  startAutoSnapshot(intervalMs: number = 5 * 60 * 1000): void {
    if (this.snapshotInterval) return;
    this.snapshotInterval = setInterval(() => void this.snapshot(), intervalMs);
  }

  stopAutoSnapshot(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  async snapshot(): Promise<PnlSnapshot | null> {
    const registry = getExchangeRegistry();
    const adapter = registry.getDefaultAdapter();
    if (!adapter || !adapter.isConnected()) return null;

    try {
      const [positions, balance] = await Promise.all([
        adapter.getPositions(),
        adapter.getBalance(),
      ]);

      const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const totalValue = balance.total;

      if (totalValue > this.peakEquity) this.peakEquity = totalValue;

      const snap: PnlSnapshot = {
        timestamp: Date.now(),
        totalValue,
        unrealizedPnl,
        realizedPnl: 0,
        positions,
      };

      this.db.savePortfolioSnapshot({
        id: `pnl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        session_id: this.sessionId,
        total_value: snap.totalValue,
        cash_balance: 0,
        invested: 0,
        unrealized_pnl: snap.unrealizedPnl,
        realized_pnl: snap.realizedPnl,
        positions_count: Array.isArray(snap.positions) ? snap.positions.length : 0,
        snapshot: JSON.stringify(snap.positions),
        taken_at: snap.timestamp,
      });

      return snap;
    } catch {
      return null;
    }
  }

  recordTrade(trade: Omit<TradeRecord, 'id' | 'timestamp'>): TradeRecord {
    const record: TradeRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...trade,
    };

    this.db.saveTradeCompat({
      id: record.id,
      timestamp: record.timestamp,
      exchange: record.exchange,
      symbol: record.symbol,
      side: record.side,
      size: record.size,
      price: record.price,
      pnl: record.pnl,
      fees: record.fees,
      strategy: record.strategy,
      rationale: record.rationale,
    });

    return record;
  }

  getEquityCurve(since?: number): EquityCurvePoint[] {
    const snaps = this.db.loadPnlSnapshots(since);
    if (snaps.length === 0) return [];

    let peak = 0;
    return snaps.reverse().map((s) => {
      if (s.totalValue > peak) peak = s.totalValue;
      const drawdown = peak > 0 ? ((peak - s.totalValue) / peak) * 100 : 0;
      return {
        timestamp: s.timestamp,
        equity: s.totalValue,
        drawdown,
      };
    });
  }

  getStrategyPnl(since?: number): StrategyPnl[] {
    const trades = this.db.loadTradesCompat({ since });
    const byStrategy = new Map<string, TradeRecord[]>();

    for (const t of trades) {
      const strategy = t.strategy || 'manual';
      if (!byStrategy.has(strategy)) byStrategy.set(strategy, []);
      byStrategy.get(strategy)!.push({
        id: t.id,
        timestamp: t.timestamp,
        exchange: t.exchange,
        symbol: t.symbol,
        side: t.side,
        size: t.size,
        price: t.price,
        pnl: t.pnl ?? undefined,
        fees: t.fees ?? undefined,
        strategy: t.strategy ?? undefined,
        rationale: t.rationale ?? undefined,
      });
    }

    const results: StrategyPnl[] = [];
    for (const [strategy, stratTrades] of byStrategy) {
      const wins = stratTrades.filter((t) => (t.pnl ?? 0) > 0);
      const totalPnl = stratTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      const totalFees = stratTrades.reduce((sum, t) => sum + (t.fees ?? 0), 0);

      results.push({
        strategy,
        totalPnl,
        tradeCount: stratTrades.length,
        winRate: stratTrades.length > 0 ? (wins.length / stratTrades.length) * 100 : 0,
        avgPnl: stratTrades.length > 0 ? totalPnl / stratTrades.length : 0,
        totalFees,
      });
    }

    return results.sort((a, b) => b.totalPnl - a.totalPnl);
  }

  getDailyPnl(days: number = 30): DailyPnl[] {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const trades = this.db.loadTradesCompat({ since });

    const byDay = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const date = new Date(t.timestamp).toISOString().slice(0, 10);
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date)!.push({
        id: t.id,
        timestamp: t.timestamp,
        exchange: t.exchange,
        symbol: t.symbol,
        side: t.side,
        size: t.size,
        price: t.price,
        pnl: t.pnl ?? undefined,
        fees: t.fees ?? undefined,
        strategy: t.strategy ?? undefined,
        rationale: t.rationale ?? undefined,
      });
    }

    const results: DailyPnl[] = [];
    for (const [date, dayTrades] of byDay) {
      const wins = dayTrades.filter((t) => (t.pnl ?? 0) > 0);
      results.push({
        date,
        pnl: dayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
        tradeCount: dayTrades.length,
        winRate: dayTrades.length > 0 ? (wins.length / dayTrades.length) * 100 : 0,
      });
    }

    return results.sort((a, b) => b.date.localeCompare(a.date));
  }

  getTradeJournal(filter?: {
    exchange?: string;
    strategy?: string;
    since?: number;
    limit?: number;
  }): TradeRecord[] {
    const trades = this.db.loadTradesCompat(filter);
    return trades.map((t) => ({
      id: t.id,
      timestamp: t.timestamp,
      exchange: t.exchange,
      symbol: t.symbol,
      side: t.side,
      size: t.size,
      price: t.price,
      pnl: t.pnl ?? undefined,
      fees: t.fees ?? undefined,
      strategy: t.strategy ?? undefined,
      rationale: t.rationale ?? undefined,
    }));
  }

  getStats(): {
    totalTrades: number;
    totalPnl: number;
    totalFees: number;
    winRate: number;
    avgPnl: number;
    bestTrade: TradeRecord | null;
    worstTrade: TradeRecord | null;
    sharpeRatio: number;
  } {
    const rawTrades = this.db.loadTradesCompat();
    const trades: TradeRecord[] = rawTrades.map((t) => ({
      id: t.id,
      timestamp: t.timestamp,
      exchange: t.exchange,
      symbol: t.symbol,
      side: t.side,
      size: t.size,
      price: t.price,
      pnl: t.pnl ?? undefined,
      fees: t.fees ?? undefined,
      strategy: t.strategy ?? undefined,
      rationale: t.rationale ?? undefined,
    }));

    const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalFees = trades.reduce((sum, t) => sum + (t.fees ?? 0), 0);

    let bestTrade: TradeRecord | null = null;
    let worstTrade: TradeRecord | null = null;

    for (const t of trades) {
      if (!bestTrade || (t.pnl ?? 0) > (bestTrade.pnl ?? 0)) {
        bestTrade = t;
      }
      if (!worstTrade || (t.pnl ?? 0) < (worstTrade.pnl ?? 0)) {
        worstTrade = t;
      }
    }

    const pnlValues = trades.map((t) => t.pnl ?? 0).filter((p) => p !== 0);
    const avgPnl = pnlValues.length > 0 ? pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length : 0;

    let sharpeRatio = 0;
    if (pnlValues.length > 1) {
      const mean = avgPnl;
      const variance = pnlValues.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnlValues.length;
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;
    }

    return {
      totalTrades: trades.length,
      totalPnl,
      totalFees,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      avgPnl,
      bestTrade,
      worstTrade,
      sharpeRatio,
    };
  }

  formatEquityCurve(): string {
    const curve = this.getEquityCurve();
    if (curve.length === 0) return 'No equity data available';

    const lines = ['Equity Curve (last 100 points):'];
    const maxPoints = 100;
    const step = Math.max(1, Math.floor(curve.length / maxPoints));

    for (let i = 0; i < curve.length; i += step) {
      const p = curve[i];
      const bar = '█'.repeat(Math.min(40, Math.floor(p.drawdown / 2)));
      const date = new Date(p.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`  ${date} | $${p.equity.toFixed(0).padStart(10)} | DD:${p.drawdown.toFixed(1).padStart(5)}% ${bar}`);
    }

    return lines.join('\n');
  }
}

export default PnlTracker;

