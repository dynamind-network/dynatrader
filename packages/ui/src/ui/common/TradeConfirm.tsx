import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from '@dynatrader/ink/terminal';
import { confirm, select, number, password } from '@inquirer/prompts';
import { MARKET_SYMBOLS } from './marketSymbols.js';

export interface TradeOrder {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  price?: number;
  stopPrice?: number;
  leverage?: number;
  reduceOnly?: boolean;
}

export interface TradeConfirmProps {
  onConfirm: (order: TradeOrder) => Promise<void>;
  onCancel: () => void;
  defaultSymbol?: string;
  availableSymbols?: string[];
}

// Interactive trade confirmation using @inquirer/prompts
// This should be used outside of Ink for proper prompt handling
export async function promptTradeOrder(
  defaultSymbol: string = '',
  availableSymbols: string[] = []
): Promise<TradeOrder | null> {
  try {
    if (availableSymbols.length === 0) {
      throw new Error('No trading symbols configured. Add instruments to the workspace first.');
    }
    // Select symbol
    const symbol = await select({
      message: 'Select trading pair:',
      choices: availableSymbols.map((s) => ({
        name: `${s}/USDT`,
        value: s,
      })),
      default: defaultSymbol,
    });

    // Select side
    const side = await select({
      message: 'Select order side:',
      choices: [
        { name: 'Buy (Long)', value: 'buy' as const },
        { name: 'Sell (Short)', value: 'sell' as const },
      ],
    });

    // Select order type
    const orderType = await select({
      message: 'Select order type:',
      choices: [
        { name: 'Market', value: 'market' as const },
        { name: 'Limit', value: 'limit' as const },
        { name: 'Stop', value: 'stop' as const },
        { name: 'Stop Limit', value: 'stop_limit' as const },
      ],
    });

    // Enter quantity
    const quantity = await number({
      message: 'Enter quantity:',
      required: true,
      min: 0.0001,
      step: 0.0001,
    });

    if (quantity === undefined) {
      return null;
    }

    let price: number | undefined;
    let stopPrice: number | undefined;

    // Get price for limit orders
    if (orderType === 'limit' || orderType === 'stop_limit') {
      price = await number({
        message: 'Enter limit price (USDT):',
        required: true,
        min: 0.0001,
        step: 0.01,
      });

      if (price === undefined) {
        return null;
      }
    }

    // Get stop price for stop orders
    if (orderType === 'stop' || orderType === 'stop_limit') {
      stopPrice = await number({
        message: 'Enter stop price (USDT):',
        required: true,
        min: 0.0001,
        step: 0.01,
      });

      if (stopPrice === undefined) {
        return null;
      }
    }

    // Enter leverage (optional)
    const useLeverage = await confirm({
      message: 'Use leverage?',
      default: false,
    });

    let leverage: number | undefined;
    if (useLeverage) {
      leverage = await number({
        message: 'Enter leverage (1-100):',
        required: true,
        min: 1,
        max: 100,
        step: 1,
      });

      if (leverage === undefined) {
        return null;
      }
    }

    // Reduce only option
    const reduceOnly = await confirm({
      message: 'Reduce only position?',
      default: false,
    });

    // Final confirmation
    const orderSummary = `
Order Summary:
  Symbol: ${symbol}/USDT
  Side: ${side.toUpperCase()}
  Type: ${orderType.toUpperCase()}
  Quantity: ${quantity}
  ${price ? `Price: ${price} USDT` : ''}
  ${stopPrice ? `Stop Price: ${stopPrice} USDT` : ''}
  ${leverage ? `Leverage: ${leverage}x` : '1x (Spot)'}
  Reduce Only: ${reduceOnly ? 'Yes' : 'No'}
    `.trim();

    console.log('\n' + orderSummary + '\n');

    const confirmed = await confirm({
      message: 'Confirm order?',
      default: false,
    });

    if (!confirmed) {
      return null;
    }

    return {
      symbol,
      side,
      type: orderType,
      quantity,
      price,
      stopPrice,
      leverage,
      reduceOnly,
    };
  } catch (_err) {
    // User cancelled the prompt
    return null;
  }
}

// Interactive price alert setup
export async function promptPriceAlert(defaultSymbol: string = ''): Promise<{
  symbol: string;
  price: number;
  direction: 'above' | 'below';
} | null> {
  try {
    const symbol = await select({
      message: 'Select asset for alert:',
      choices: MARKET_SYMBOLS.slice(0, 7).map((s) => ({
        name: `${s}/USDT`,
        value: s,
      })),
      default: defaultSymbol || MARKET_SYMBOLS[0] || '',
    });

    const direction = await select({
      message: 'Alert when price goes:',
      choices: [
        { name: 'Above', value: 'above' as const },
        { name: 'Below', value: 'below' as const },
      ],
    });

    const price = await number({
      message: 'Enter target price (USDT):',
      required: true,
      min: 0.0001,
      step: 0.01,
    });

    if (price === undefined) {
      return null;
    }

    const confirmed = await confirm({
      message: `Alert ${symbol} when price goes ${direction} $${price}?`,
      default: true,
    });

    if (!confirmed) {
      return null;
    }

    return { symbol, price, direction };
  } catch (_err) {
    // User cancelled the prompt
    return null;
  }
}

// Interactive settings wizard
export async function promptSettings(): Promise<Record<string, unknown> | null> {
  try {
    const theme = await select({
      message: 'Select color theme:',
      choices: [
        { name: 'Dark (Default)', value: 'dark' },
        { name: 'Light', value: 'light' },
        { name: 'Monochrome', value: 'mono' },
      ],
    });

    const showAnimations = await confirm({
      message: 'Enable animations?',
      default: true,
    });

    const autoConnect = await confirm({
      message: 'Auto-connect to exchanges on startup?',
      default: true,
    });

    const refreshRate = await number({
      message: 'Data refresh rate (seconds):',
      default: 5,
      min: 1,
      max: 60,
      step: 1,
    });

    const apiKey = await password({
      message: 'Enter API key (optional, press Enter to skip):',
      mask: '*',
    });

    return {
      theme,
      showAnimations,
      autoConnect,
      refreshRate: refreshRate || 5,
      apiKey: apiKey || undefined,
    };
  } catch (_err) {
    // User cancelled the prompt
    return null;
  }
}

// Quick trade prompt for inline use
export async function promptQuickTrade(
  symbol: string,
  currentPrice: number
): Promise<{ side: 'buy' | 'sell'; quantity: number } | null> {
  try {
    const side = await select({
      message: `Trade ${symbol} at $${currentPrice.toFixed(2)}:`,
      choices: [
        { name: 'Buy', value: 'buy' as const },
        { name: 'Sell', value: 'sell' as const },
      ],
    });

    const quantity = await number({
      message: `Enter ${symbol} quantity:`,
      required: true,
      min: 0.0001,
      step: 0.0001,
    });

    if (quantity === undefined) {
      return null;
    }

    const totalValue = quantity * currentPrice;
    const confirmed = await confirm({
      message: `${side.toUpperCase()} ${quantity} ${symbol} ($${totalValue.toFixed(2)})?`,
      default: false,
    });

    if (!confirmed) {
      return null;
    }

    return { side, quantity };
  } catch (_err) {
    // User cancelled the prompt
    return null;
  }
}

// Ink-compatible TradeConfirm component for visual display
export function TradeConfirmDisplay({
  order,
  onApprove,
  onReject,
}: {
  order: TradeOrder;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [selected, setSelected] = useState<'approve' | 'reject'>('approve');

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || input === '\t') {
      setSelected((prev) => (prev === 'approve' ? 'reject' : 'approve'));
    } else if (key.return) {
      if (selected === 'approve') {
        onApprove();
      } else {
        onReject();
      }
    } else if (input === 'y' || input === 'Y') {
      onApprove();
    } else if (input === 'n' || input === 'N') {
      onReject();
    }
  });

  const totalValue = order.quantity * (order.price || 0);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Text color="yellow" bold>
        ORDER CONFIRMATION
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>Symbol: </Text>
          <Text bold>{order.symbol}/USDT</Text>
        </Box>
        <Box>
          <Text dimColor>Side: </Text>
          <Text color={order.side === 'buy' ? 'green' : 'red'} bold>
            {order.side.toUpperCase()}
          </Text>
        </Box>
        <Box>
          <Text dimColor>Type: </Text>
          <Text>{order.type.toUpperCase()}</Text>
        </Box>
        <Box>
          <Text dimColor>Quantity: </Text>
          <Text>{order.quantity}</Text>
        </Box>
        {order.price && (
          <Box>
            <Text dimColor>Price: </Text>
            <Text>${order.price}</Text>
          </Box>
        )}
        {order.stopPrice && (
          <Box>
            <Text dimColor>Stop Price: </Text>
            <Text>${order.stopPrice}</Text>
          </Box>
        )}
        {order.leverage && order.leverage > 1 && (
          <Box>
            <Text dimColor>Leverage: </Text>
            <Text color="yellow">{order.leverage}x</Text>
          </Box>
        )}
        {order.reduceOnly && (
          <Box>
            <Text color="magenta">Reduce Only</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} justifyContent="center">
        <Text color={selected === 'approve' ? 'green' : 'white'} inverse={selected === 'approve'}>
          [Y] Approve{'  '}
        </Text>
        <Text color={selected === 'reject' ? 'red' : 'white'} inverse={selected === 'reject'}>
          [N] Reject
        </Text>
      </Box>
    </Box>
  );
}

export default TradeConfirmDisplay;

