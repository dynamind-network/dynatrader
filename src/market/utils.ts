export function normalizeMarketRecord(market: unknown): Record<string, unknown> | null {
  if (!market || typeof market !== 'object') {
    return null;
  }

  const record = market as Record<string, unknown>;
  const symbol = typeof record.symbol === 'string' ? record.symbol.trim() : '';
  if (!symbol) {
    return null;
  }

  return {
    symbol,
    status: record.status,
    tradable: record.tradable,
    type: record.type,
    quoteCurrency: record.quoteCurrency ?? record.quote_currency,
    baseCurrency: record.baseCurrency ?? record.base_currency,
    volume24h: record.volume24h ?? record.volume24hUsd ?? record.volume,
  };
}
