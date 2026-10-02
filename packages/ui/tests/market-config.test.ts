import { describe, expect, it } from 'vitest';
import {
  initMarketConfig,
  MARKET_SYMBOLS,
  getMarketSymbols,
  getPrimaryMarketSymbol,
} from '../src/config/market.js';

describe('market config', () => {
  it('uses workspace-configured symbols when provided', () => {
    initMarketConfig({ symbols: ['XRP', 'SOL', 'ETH'] });
    expect(MARKET_SYMBOLS).toEqual(['XRP', 'SOL', 'ETH']);
    expect(getMarketSymbols()).toEqual(['XRP', 'SOL', 'ETH']);
    expect(getPrimaryMarketSymbol()).toBe('XRP');
  });

  it('falls back to the shared exchange symbol universe when no config is provided', () => {
    initMarketConfig({ symbols: [] });
    expect(MARKET_SYMBOLS.length).toBeGreaterThan(0);
  });
});
