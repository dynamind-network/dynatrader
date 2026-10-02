import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import { useLiveTicker } from './LiveTicker.js';
import { MARKET_SYMBOLS } from './marketSymbols.js';

interface LiveTickerStripProps {
  width: number;
}

interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
}

function formatPrice(price: number): string {
  if (price >= 10000) return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
}

export function LiveTickerStrip({ width }: LiveTickerStripProps) {
  const symbols: string[] = MARKET_SYMBOLS.slice(0, 3);
  const { tickers, isConnected } = useLiveTicker(symbols);

  if (width < 80) {
    return null;
  }

  const tickerItems = symbols.map((symbol) => {
    const data = tickers.get(symbol);
    return { symbol, data };
  });

  const allMissing = tickerItems.every((item) => !item.data);

  if (!isConnected && allMissing) {
    return (
      <Box>
        <Text dimColor>...</Text>
      </Box>
    );
  }

  return (
    <Box>
      {tickerItems.map((item, idx) => {
        const { symbol, data } = item;
        return (
          <React.Fragment key={symbol}>
            {idx > 0 && <Text dimColor> </Text>}
            <Text bold>{symbol}</Text>
            <Text> {data ? `$${formatPrice(data.price)}` : '--'}</Text>
            {data ? (
              <Text color={data.change24h >= 0 ? 'green' : 'red'}>
                {' '}
                ({data.change24h >= 0 ? '+' : ''}
                {data.change24h.toFixed(1)}%)
              </Text>
            ) : (
              <Text dimColor> (--)</Text>
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

export default LiveTickerStrip;

