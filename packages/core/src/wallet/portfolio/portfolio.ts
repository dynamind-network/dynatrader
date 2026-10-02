import { PositionManager } from '../position/position-manager';
import { PositionStatus, PositionSide } from '../position/types';
import type { PositionId } from '../position/types';
import type {
  PortfolioSnapshot,
  PositionSnapshot,
  ChainExposure,
  SymbolExposure,
  PnLSummary,
  PnLByChain,
  PortfolioConfig,
} from './types';
import type { SupportedChainId } from '../types';

// ---------------------------------------------------------------------------
// Portfolio Class (Nautilus pattern: PnL aggregation + exposure tracking)
// ---------------------------------------------------------------------------

export class Portfolio {
  private _positionManager: PositionManager;
  private _config: PortfolioConfig;
  private _balance: number;
  private _realizedPnl = 0;
  private _snapshots: PortfolioSnapshot[] = [];

  constructor(positionManager: PositionManager, config: PortfolioConfig) {
    this._positionManager = positionManager;
    this._config = config;
    this._balance = config.initialBalance;
  }

  // -- Balance --

  get balance(): number { return this._balance; }
  get equity(): number { return this._balance + this._positionsValue(); }

  // -- PnL Queries (Nautilus pattern) --

  realizedPnl(): number { return this._realizedPnl; }

  unrealizedPnl(currentPrices: Map<string, string>): number {
    let total = 0;
    const openPositions = this._positionManager.openPositions();

    for (const pos of openPositions) {
      const price = currentPrices.get(pos.symbol);
      if (price) {
        total += pos.unrealizedPnl(price);
      }
    }

    return total;
  }

  totalPnl(currentPrices: Map<string, string>): number {
    return this._realizedPnl + this.unrealizedPnl(currentPrices);
  }

  // -- Position Queries (Nautilus pattern) --

  netPosition(symbol: string, chainId: number): number {
    return this._positionManager.netPosition(symbol, chainId);
  }

  isNetLong(symbol: string, chainId: number): boolean {
    return this._positionManager.isNetLong(symbol, chainId);
  }

  isNetShort(symbol: string, chainId: number): boolean {
    return this._positionManager.isNetShort(symbol, chainId);
  }

  isNetFlat(symbol: string, chainId: number): boolean {
    return this._positionManager.isNetFlat(symbol, chainId);
  }

  // -- Exposure Queries --

  totalExposure(): number {
    return this._positionManager.totalExposure();
  }

  exposureByChain(): ChainExposure[] {
    const chainMap = new Map<SupportedChainId, { exposure: number; count: number }>();
    const openPositions = this._positionManager.openPositions();

    for (const pos of openPositions) {
      const existing = chainMap.get(pos.chainId) || { exposure: 0, count: 0 };
      existing.exposure += parseFloat(pos.quantity);
      existing.count += 1;
      chainMap.set(pos.chainId, existing);
    }

    return Array.from(chainMap.entries()).map(([chainId, data]) => ({
      chainId,
      chainName: this._chainName(chainId),
      exposure: data.exposure,
      positionCount: data.count,
    }));
  }

  exposureBySymbol(): SymbolExposure[] {
    const symbolMap = new Map<string, {
      long: number;
      short: number;
      count: number;
    }>();
    const openPositions = this._positionManager.openPositions();

    for (const pos of openPositions) {
      const existing = symbolMap.get(pos.symbol) || { long: 0, short: 0, count: 0 };
      if (pos.isLong) {
        existing.long += parseFloat(pos.quantity);
      } else {
        existing.short += parseFloat(pos.quantity);
      }
      existing.count += 1;
      symbolMap.set(pos.symbol, existing);
    }

    return Array.from(symbolMap.entries()).map(([symbol, data]) => ({
      symbol,
      totalExposure: data.long + data.short,
      longExposure: data.long,
      shortExposure: data.short,
      netExposure: data.long - data.short,
      positionCount: data.count,
    }));
  }

  // -- Snapshot --

  snapshot(currentPrices: Map<string, string>): PortfolioSnapshot {
    const openPositions = this._positionManager.openPositions();
    const positionsValue = this._positionsValueWithPrices(currentPrices);
    const unrealized = this.unrealizedPnl(currentPrices);

    const positionSnapshots: PositionSnapshot[] = openPositions.map(pos => {
      const price = currentPrices.get(pos.symbol) || pos.avgPxOpen;
      return {
        symbol: pos.symbol,
        chainId: pos.chainId,
        side: pos.side,
        quantity: pos.quantity,
        avgPxOpen: pos.avgPxOpen,
        currentPrice: price,
        unrealizedPnl: pos.unrealizedPnl(price),
        notionalValue: pos.notionalValue(price),
      };
    });

    const snapshot: PortfolioSnapshot = {
      timestamp: Date.now(),
      totalEquity: this._balance + positionsValue,
      cashBalance: this._balance,
      positionsValue,
      unrealizedPnl: unrealized,
      realizedPnl: this._realizedPnl,
      positions: positionSnapshots,
    };

    this._snapshots.push(snapshot);
    return snapshot;
  }

  // -- PnL by Chain --

  pnlByChain(currentPrices: Map<string, string>): PnLByChain[] {
    const chainMap = new Map<SupportedChainId, { realized: number; unrealized: number }>();
    const openPositions = this._positionManager.openPositions();

    for (const pos of openPositions) {
      const existing = chainMap.get(pos.chainId) || { realized: 0, unrealized: 0 };
      const price = currentPrices.get(pos.symbol) || pos.avgPxOpen;
      existing.unrealized += pos.unrealizedPnl(price);
      chainMap.set(pos.chainId, existing);
    }

    return Array.from(chainMap.entries()).map(([chainId, data]) => ({
      chainId,
      realizedPnl: data.realized,
      unrealizedPnl: data.unrealized,
      totalPnl: data.realized + data.unrealized,
    }));
  }

  // -- Update Balance (called after fills) --

  updateBalance(amount: number): void {
    this._balance += amount;
  }

  addRealizedPnl(pnl: number): void {
    this._realizedPnl += pnl;
  }

  // -- Internal Helpers --

  private _positionsValue(): number {
    let total = 0;
    for (const pos of this._positionManager.openPositions()) {
      total += parseFloat(pos.quantity) * parseFloat(pos.avgPxOpen);
    }
    return total;
  }

  private _positionsValueWithPrices(currentPrices: Map<string, string>): number {
    let total = 0;
    for (const pos of this._positionManager.openPositions()) {
      const price = currentPrices.get(pos.symbol) || pos.avgPxOpen;
      total += parseFloat(pos.quantity) * parseFloat(price);
    }
    return total;
  }

  private _chainName(chainId: SupportedChainId): string {
    const names: Record<number, string> = {
      1: 'Ethereum',
      137: 'Polygon',
      56: 'BSC',
      42161: 'Arbitrum',
      8453: 'Base',
      10: 'Optimism',
    };
    return names[chainId] || `Chain ${chainId}`;
  }
}
