import type { ExchangeRiskSnapshot, OrderIntent } from '@dyna/contracts';

export interface LiveRiskLimits {
  maxDailyLossPct: number;
  maxConcurrentPositions: number;
}

/** Position size as a fraction of account equity (0.10 means ten percent). */
export function positionNotionalPct(quantity: number, price: number, equity: number): number {
  return quantity * price / equity;
}

/** Validate venue-supplied live risk data before an order reaches the venue. */
export function validateLiveRiskSnapshot(
  snapshot: ExchangeRiskSnapshot,
  intent: Pick<OrderIntent, 'symbol'>,
  limits: LiveRiskLimits,
  now = Date.now(),
): string | null {
  if (!snapshot || !Number.isFinite(snapshot.equity) || snapshot.equity <= 0) {
    return 'Live trading is disabled because the exchange risk snapshot has invalid equity.';
  }
  if (!Number.isFinite(snapshot.dailyPnlPct)) {
    return 'Live trading is disabled because the exchange risk snapshot has no valid daily PnL.';
  }
  if (!Array.isArray(snapshot.openPositions) || snapshot.openPositions.some((position) =>
    !position || typeof position.symbol !== 'string' || !position.symbol.trim() || !Number.isFinite(position.quantity))) {
    return 'Live trading is disabled because the exchange risk snapshot has invalid open positions.';
  }
  if (!Number.isFinite(snapshot.asOf) || snapshot.asOf > now + 1_000 || now - snapshot.asOf > 60_000) {
    return 'Live trading is disabled because the exchange risk snapshot is stale.';
  }

  if (Math.max(0, -snapshot.dailyPnlPct) >= limits.maxDailyLossPct) {
    return 'Configured daily loss limit has been reached.';
  }

  const activePositions = snapshot.openPositions.filter((position) => position.quantity !== 0);
  const hasPosition = activePositions.some((position) => position.symbol.trim().toUpperCase() === intent.symbol.trim().toUpperCase());
  if (!hasPosition && activePositions.length >= limits.maxConcurrentPositions) {
    return 'Configured maximum concurrent positions has been reached.';
  }

  return null;
}
