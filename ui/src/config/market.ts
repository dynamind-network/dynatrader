import { SUPPORTED_SYMBOLS } from '../services/websocket/index.js';

export interface MarketConfig {
  symbols?: string[];
}

const defaultMarketConfig: Required<MarketConfig> = {
  symbols: [],
};

export let marketConfig: Required<MarketConfig> = { ...defaultMarketConfig };
export let MARKET_SYMBOLS: string[] = SUPPORTED_SYMBOLS;

export function initMarketConfig(overrides?: Partial<MarketConfig>): void {
  marketConfig = {
    ...defaultMarketConfig,
    ...overrides,
  };

  MARKET_SYMBOLS =
    marketConfig.symbols.length > 0 ? [...marketConfig.symbols] : [...SUPPORTED_SYMBOLS];
}

export function getMarketSymbols(): string[] {
  return [...MARKET_SYMBOLS];
}

export function getPrimaryMarketSymbol(): string {
  return MARKET_SYMBOLS[0] ?? '';
}
