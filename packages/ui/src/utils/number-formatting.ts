/**
 * Number and value formatting utilities for consistent output formatting
 */

function usd(value: number, decimals = 2): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function percent(value: number, decimals = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function decimal(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function number(value: number, decimals = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function signed(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}

function volume(value: number): string {
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)}K`;
  }
  return value.toFixed(2);
}

function parse(value: string | number, defaultValue = 0): number {
  if (typeof value === 'number') return value;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function calculatePnL(
  entryPrice: number,
  exitPrice: number,
  quantity: number
): { pnl: number; pnlPercent: number } {
  const pnl = (exitPrice - entryPrice) * quantity;
  const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
  return { pnl, pnlPercent };
}

function sign(value: number): string {
  return value >= 0 ? '+' : '';
}

function pnl(value: number, currency = '$', decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  const formatted =
    decimals === 0
      ? value.toFixed(0)
      : value.toLocaleString('en-US', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
  return `${sign}${currency}${formatted}`;
}

function pnlPercent(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

function price(value: number): string {
  if (value < 0.01) {
    return value.toFixed(8);
  }
  if (value < 1) {
    return value.toFixed(4);
  }
  return value.toFixed(2);
}

/**
 * Format a price value for display (handles large numbers with locale formatting)
 */
function formatPrice(price: number): string {
  if (price >= 10000) {
    return price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (price >= 1000) {
    return price.toFixed(1);
  }
  if (price >= 1) {
    return price.toFixed(2);
  }
  return price.toFixed(4);
}

/**
 * Format a quantity for display with K/M suffixes
 */
function formatQuantity(quantity: number): string {
  if (quantity >= 1000000) {
    return `${(quantity / 1000000).toFixed(2)}M`;
  }
  if (quantity >= 1000) {
    return `${(quantity / 1000).toFixed(2)}K`;
  }
  return quantity.toFixed(4);
}

/**
 * Format a percentage for display with sign
 */
function formatPercent(percent: number): string {
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

/**
 * Format PnL for display with sign and K suffix for large values
 */
function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  const formatted = Math.abs(pnl) >= 1000 ? (pnl / 1000).toFixed(1) + 'K' : pnl.toFixed(2);
  return `${sign}$${formatted}`;
}

export const NumberFormat = {
  usd,
  percent,
  decimal,
  number,
  signed,
  volume,
  parse,
  calculatePnL,
  sign,
  pnl,
  pnlPercent,
  price,
};

// Re-export standalone formatting functions for backward compatibility
export { formatPrice, formatQuantity, formatPercent, formatPnL };

