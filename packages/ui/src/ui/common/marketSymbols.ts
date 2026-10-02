export { MARKET_SYMBOLS, getMarketSymbols, getPrimaryMarketSymbol } from '../../config/market.js';

import { getMarketSymbols } from '../../config/market.js';

export function createSymbolPattern(symbols: string[] = getMarketSymbols()): RegExp {
  const escaped = symbols
    .filter((symbol) => symbol.trim().length > 0)
    .map((symbol) => symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (escaped.length === 0) {
    return /\b\B/;
  }

  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
}

