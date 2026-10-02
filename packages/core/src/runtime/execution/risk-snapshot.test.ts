import { describe, expect, it } from 'vitest';
import { positionNotionalPct, validateLiveRiskSnapshot } from './risk-snapshot';
import type { ExchangeRiskSnapshot } from '@dyna/contracts';

const now = 1_800_000_000_000;
const limits = { maxDailyLossPct: 0.03, maxConcurrentPositions: 2 };
const snapshot: ExchangeRiskSnapshot = {
  equity: 10_000,
  dailyPnlPct: 0.01,
  openPositions: [{ symbol: 'BTC/USD', quantity: 1 }],
  asOf: now,
};

describe('validateLiveRiskSnapshot', () => {
  it('measures position size using notional as a fraction of equity', () => {
    expect(positionNotionalPct(2, 250, 10_000)).toBe(0.05);
  });

  it('accepts a fresh snapshot below the configured limits', () => {
    expect(validateLiveRiskSnapshot(snapshot, { symbol: 'ETH/USD' }, limits, now)).toBeNull();
  });

  it('blocks at the configured daily drawdown threshold', () => {
    expect(validateLiveRiskSnapshot({ ...snapshot, dailyPnlPct: -0.03 }, { symbol: 'ETH/USD' }, limits, now))
      .toMatch(/daily loss limit/i);
  });

  it('blocks opening another position when the concurrent cap is reached', () => {
    expect(validateLiveRiskSnapshot({ ...snapshot, openPositions: [
      { symbol: 'BTC/USD', quantity: 1 },
      { symbol: 'SOL/USD', quantity: -2 },
    ] }, { symbol: 'ETH/USD' }, limits, now)).toMatch(/maximum concurrent positions/i);
  });

  it('allows orders that add to an already-counted position at the concurrent cap', () => {
    expect(validateLiveRiskSnapshot({ ...snapshot, openPositions: [
      { symbol: 'BTC/USD', quantity: 1 },
      { symbol: 'SOL/USD', quantity: 2 },
    ] }, { symbol: 'btc/usd' }, limits, now)).toBeNull();
  });

  it.each([
    ['stale', { ...snapshot, asOf: now - 60_001 }],
    ['invalid equity', { ...snapshot, equity: Number.NaN }],
    ['invalid position', { ...snapshot, openPositions: [{ symbol: '', quantity: 1 }] }],
  ])('fails closed for %s risk data', (_label, invalidSnapshot) => {
    expect(validateLiveRiskSnapshot(invalidSnapshot, { symbol: 'ETH/USD' }, limits, now)).toMatch(/disabled/i);
  });
});
