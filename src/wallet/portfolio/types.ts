import type { SupportedChainId } from '../types';
import type { PositionSide } from '../position/types';

// ---------------------------------------------------------------------------
// Portfolio Types
// ---------------------------------------------------------------------------

export interface PortfolioSnapshot {
  timestamp: number;
  totalEquity: number;
  cashBalance: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: PositionSnapshot[];
}

export interface PositionSnapshot {
  symbol: string;
  chainId: SupportedChainId;
  side: PositionSide;
  quantity: string;
  avgPxOpen: string;
  currentPrice: string;
  unrealizedPnl: number;
  notionalValue: number;
}

// ---------------------------------------------------------------------------
// Exposure Types
// ---------------------------------------------------------------------------

export interface ChainExposure {
  chainId: SupportedChainId;
  chainName: string;
  exposure: number;
  positionCount: number;
}

export interface SymbolExposure {
  symbol: string;
  totalExposure: number;
  longExposure: number;
  shortExposure: number;
  netExposure: number;
  positionCount: number;
}

// ---------------------------------------------------------------------------
// PnL Types
// ---------------------------------------------------------------------------

export interface PnLSummary {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  realizedReturn: number;
  unrealizedReturn: number;
  totalReturn: number;
}

export interface PnLByChain {
  chainId: SupportedChainId;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
}

// ---------------------------------------------------------------------------
// Portfolio Statistics
// ---------------------------------------------------------------------------

export interface PortfolioStatistics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpeRatio?: number;
}

// ---------------------------------------------------------------------------
// Portfolio Config
// ---------------------------------------------------------------------------

export interface PortfolioConfig {
  initialBalance: number;
  quoteCurrency: string;
  maxExposurePerChain: number;
  maxExposurePerSymbol: number;
  maxTotalExposure: number;
}
