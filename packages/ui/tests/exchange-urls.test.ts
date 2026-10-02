import { describe, expect, it } from 'vitest';
import { initProviders } from '../src/config/providers.js';
import { resolveExchangeWebSocketUrl } from '../src/config/exchange-urls.js';

describe('exchange url overrides', () => {
  it('falls back to the adapter url unless an override is configured', () => {
    initProviders({ exchangeUrls: { binance: 'wss://example.invalid/ws' } });
    expect(resolveExchangeWebSocketUrl('binance', 'wss://fallback.invalid/ws')).toBe(
      'wss://example.invalid/ws'
    );
    expect(resolveExchangeWebSocketUrl('okx', 'wss://fallback.invalid/ws')).toBe(
      'wss://fallback.invalid/ws'
    );
  });
});
