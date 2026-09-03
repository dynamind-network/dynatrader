// Wallet and portfolio types

export interface WalletBalance {
  address: string;
  chain: string;
  token: string;
  symbol: string;
  balance: string;
  decimals: number;
  priceUsd: number;
  valueUsd: number;
}

export interface Portfolio {
  totalValueUsd: number;
  balances: WalletBalance[];
  lastUpdated: Date;
  chains: string[];
}

export interface PositionWithPnL {
  symbol: string;
  chain: string;
  token: string;
  name?: string;
  quantity: number;
  amount?: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  valueUsd: number;
}

export interface StoredPosition {
  symbol: string;
  chain: string;
  quantity: number;
  entryPrice: number;
  entryTimestamp: Date;
}

export interface PortfolioData {
  positions: StoredPosition[];
  lastUpdated: Date;
}

export interface WalletInfo {
  address: string;
  chains: string[];
  totalValueUsd: number;
  transactions: number;
}
