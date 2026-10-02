/**
 * TradeTool — Live order execution via ExchangeRegistry
 *
 * Exposes place_order, cancel_order, get_positions, get_open_orders, get_balance
 * with safety checks, dry-run mode, and audit trail logging.
 */

import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import {
  getExchangeRegistry,
  type ExchangeName,
  type OrderParams,
} from '../exchanges/registry.js';
import { randomUUID } from 'crypto';

export interface TradeToolOptions {
  dryRun?: boolean;
  requireApproval?: boolean;
}

const VALID_EXCHANGES: ExchangeName[] = [
  'hyperliquid', 'binance', 'bybit', 'polymarket', 'coinbase',
];

const VALID_SIDES = ['buy', 'sell'] as const;
const VALID_ORDER_TYPES = ['market', 'limit'] as const;
const MAX_ORDER_SIZE = 1_000_000;
const SYMBOL_REGEX = /^[A-Z0-9\-\/]+$/;
const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export class TradeTool extends BaseTool {
  name = 'trade';
  description = `Execute trades on connected exchanges. Actions: place_order, cancel_order, get_positions, get_open_orders, get_balance.
Place order requires: exchange, symbol, side, orderType, size. Limit orders also require price.
Safety: dry-run mode available, all trades logged to audit trail, approval required in default mode.`;
  isDestructive = true;
  requiresApproval = true;
  riskLevel = 'high' as const;

  private dryRun: boolean;
  private auditLog: Array<{
    id: string;
    timestamp: number;
    action: string;
    exchange: string;
    details: Record<string, unknown>;
    result?: string;
    error?: string;
  }> = [];

  constructor(options?: TradeToolOptions) {
    super();
    this.dryRun = options?.dryRun ?? false;
    this.requiresApproval = options?.requireApproval ?? true;
  }

  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Trade action to perform',
        enum: ['place_order', 'cancel_order', 'get_positions', 'get_open_orders', 'get_balance'],
      },
      exchange: {
        type: 'string',
        description: `Exchange to trade on. Options: ${VALID_EXCHANGES.join(', ')}`,
      },
      symbol: {
        type: 'string',
        description: 'Trading pair symbol (e.g., BTCUSDT, ETH-PERP)',
      },
      side: {
        type: 'string',
        description: 'Order side',
        enum: ['buy', 'sell'],
      },
      orderType: {
        type: 'string',
        description: 'Order type',
        enum: ['market', 'limit'],
      },
      size: {
        type: 'number',
        description: 'Order size (quantity)',
      },
      price: {
        type: 'number',
        description: 'Limit price (required for limit orders)',
      },
      reduceOnly: {
        type: 'boolean',
        description: 'Reduce position only (close/reduce)',
      },
      postOnly: {
        type: 'boolean',
        description: 'Post-only order (maker only)',
      },
      orderId: {
        type: 'string',
        description: 'Order ID to cancel (for cancel_order)',
      },
    },
    required: ['action'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const action = input.action as string;

    const validationErrors = this.validateInput(input);
    if (validationErrors.length > 0) {
      return this.error(validationErrors.join('; '));
    }

    const auditId = randomUUID();
    const auditEntry: {
      id: string;
      timestamp: number;
      action: string;
      exchange: string;
      details: Record<string, unknown>;
      result?: string;
      error?: string;
    } = {
      id: auditId,
      timestamp: Date.now(),
      action,
      exchange: (input.exchange as string) || 'default',
      details: input,
    };

    try {
      let result: ToolResult;

      switch (action) {
        case 'place_order':
          result = await this.placeOrder(input);
          break;
        case 'cancel_order':
          result = await this.cancelOrder(input);
          break;
        case 'get_positions':
          result = await this.getPositions(input);
          break;
        case 'get_open_orders':
          result = await this.getOpenOrders(input);
          break;
        case 'get_balance':
          result = await this.getBalance(input);
          break;
        default:
          result = this.error(`Unknown action: ${action}`);
      }

      auditEntry.result = result.output;
      this.auditLog.push(auditEntry);
      if (this.auditLog.length > 500) {
        this.auditLog = this.auditLog.slice(-250);
      }

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      auditEntry.error = errorMsg;
      this.auditLog.push(auditEntry);
      return this.error(`Trade failed: ${errorMsg}`);
    }
  }

  private async placeOrder(input: Record<string, unknown>): Promise<ToolResult> {
    const exchangeName = input.exchange as ExchangeName;
    const symbol = (input.symbol as string)?.toUpperCase();
    const side = input.side as 'buy' | 'sell';
    const orderType = input.orderType as 'market' | 'limit';
    const size = input.price as number;
    const price = input.price as number | undefined;
    const reduceOnly = input.reduceOnly as boolean | undefined;
    const postOnly = input.postOnly as boolean | undefined;

    if (!exchangeName) return this.error('Exchange is required');
    if (!VALID_EXCHANGES.includes(exchangeName)) {
      return this.error(`Invalid exchange: ${exchangeName}. Valid: ${VALID_EXCHANGES.join(', ')}`);
    }
    if (!symbol) return this.error('Symbol is required');
    if (!SYMBOL_REGEX.test(symbol)) {
      return this.error(`Invalid symbol format: ${symbol}`);
    }
    if (!side || !VALID_SIDES.includes(side)) {
      return this.error(`Invalid side: ${side}. Valid: buy, sell`);
    }
    if (!orderType || !VALID_ORDER_TYPES.includes(orderType)) {
      return this.error(`Invalid orderType: ${orderType}. Valid: market, limit`);
    }
    if (typeof input.size !== 'number' || input.size <= 0) {
      return this.error('Size must be a positive number');
    }
    if (input.size > MAX_ORDER_SIZE) {
      return this.error(`Size exceeds maximum: ${MAX_ORDER_SIZE}`);
    }
    if (orderType === 'limit' && (typeof price !== 'number' || price <= 0)) {
      return this.error('Limit orders require a positive price');
    }

    const registry = getExchangeRegistry();
    const adapter = registry.get(exchangeName);
    if (!adapter) {
      return this.error(`Exchange ${exchangeName} is not registered. Use /connect ${exchangeName} first.`);
    }
    if (!adapter.isConnected()) {
      return this.error(`Exchange ${exchangeName} is not connected. Use /connect ${exchangeName} first.`);
    }

    const orderParams: OrderParams = {
      symbol,
      side,
      orderType,
      size: input.size as number,
      price,
      reduceOnly,
      postOnly,
    };

    if (this.dryRun) {
      return this.success(
        `[DRY RUN] Would place ${side} ${orderType} order:\n` +
          `  Exchange: ${exchangeName}\n` +
          `  Symbol: ${symbol}\n` +
          `  Size: ${input.size}\n` +
          (price ? `  Price: ${price}\n` : '') +
          (reduceOnly ? '  Reduce only: true\n' : '') +
          (postOnly ? '  Post only: true\n' : '')
      );
    }

    const result = await adapter.placeOrder(orderParams);

    if (!result.success) {
      return this.error(`Order failed: ${result.message || 'Unknown error'}`);
    }

    const lines = [
      `Order placed successfully`,
      `  Exchange: ${exchangeName}`,
      `  Order ID: ${result.orderId}`,
      `  Symbol: ${symbol}`,
      `  Side: ${side}`,
      `  Type: ${orderType}`,
      `  Size: ${input.size}`,
    ];

    if (result.filledPrice) lines.push(`  Filled Price: ${result.filledPrice}`);
    if (result.filledSize) lines.push(`  Filled Size: ${result.filledSize}`);

    return this.success(lines.join('\n'));
  }

  private async cancelOrder(input: Record<string, unknown>): Promise<ToolResult> {
    const exchangeName = input.exchange as ExchangeName;
    const orderId = input.orderId as string;
    const symbol = (input.symbol as string)?.toUpperCase();

    if (!exchangeName || !VALID_EXCHANGES.includes(exchangeName)) {
      return this.error(`Invalid exchange: ${exchangeName}`);
    }
    if (!orderId) return this.error('orderId is required for cancel_order');
    if (!symbol) return this.error('symbol is required for cancel_order');

    const registry = getExchangeRegistry();
    const adapter = registry.get(exchangeName);
    if (!adapter || !adapter.isConnected()) {
      return this.error(`Exchange ${exchangeName} is not connected`);
    }

    if (this.dryRun) {
      return this.success(`[DRY RUN] Would cancel order ${orderId} on ${exchangeName}`);
    }

    const result = await adapter.cancelOrder(orderId, symbol);

    if (!result.success) {
      return this.error(`Cancel failed: ${result.message || 'Unknown error'}`);
    }

    return this.success(`Order ${orderId} cancelled on ${exchangeName}`);
  }

  private async getPositions(input: Record<string, unknown>): Promise<ToolResult> {
    const exchangeName = input.exchange as ExchangeName | undefined;

    const registry = getExchangeRegistry();
    const adapter = exchangeName
      ? registry.get(exchangeName)
      : registry.getDefaultAdapter();

    if (!adapter) return this.error(`Exchange ${exchangeName || 'default'} not found`);
    if (!adapter.isConnected()) return this.error(`Exchange ${exchangeName || 'default'} not connected`);

    const positions = await adapter.getPositions();

    if (positions.length === 0) {
      return this.success(`No open positions on ${adapter.name}`);
    }

    const lines = [`Open positions on ${adapter.name}:`];
    for (const pos of positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
      lines.push(
        `  ${pos.symbol} ${pos.side.toUpperCase()} ${pos.size} @ $${pos.entryPrice.toFixed(2)} ` +
          `| PnL: ${pnlSign}$${pos.unrealizedPnl.toFixed(2)} (${pnlSign}${pos.unrealizedPnlPercent.toFixed(2)}%) ` +
          `| Leverage: ${pos.leverage}x` +
          (pos.liquidationPrice ? ` | Liq: $${pos.liquidationPrice.toFixed(2)}` : '')
      );
    }

    return this.success(lines.join('\n'));
  }

  private async getOpenOrders(input: Record<string, unknown>): Promise<ToolResult> {
    const exchangeName = input.exchange as ExchangeName | undefined;

    const registry = getExchangeRegistry();
    const adapter = exchangeName
      ? registry.get(exchangeName)
      : registry.getDefaultAdapter();

    if (!adapter) return this.error(`Exchange ${exchangeName || 'default'} not found`);
    if (!adapter.isConnected()) return this.error(`Exchange ${exchangeName || 'default'} not connected`);
    if (!adapter.getOpenOrders) return this.error(`${adapter.name} does not support getOpenOrders`);

    const orders = await adapter.getOpenOrders();

    if (orders.length === 0) {
      return this.success(`No open orders on ${adapter.name}`);
    }

    const lines = [`Open orders on ${adapter.name}:`];
    for (const order of orders) {
      lines.push(
        `  ${order.orderId} | ${order.success ? 'OK' : 'FAILED'}`
      );
    }

    return this.success(lines.join('\n'));
  }

  private async getBalance(input: Record<string, unknown>): Promise<ToolResult> {
    const exchangeName = input.exchange as ExchangeName | undefined;

    const registry = getExchangeRegistry();
    const adapter = exchangeName
      ? registry.get(exchangeName)
      : registry.getDefaultAdapter();

    if (!adapter) return this.error(`Exchange ${exchangeName || 'default'} not found`);
    if (!adapter.isConnected()) return this.error(`Exchange ${exchangeName || 'default'} not connected`);

    const balance = await adapter.getBalance();

    return this.success(
      `Balance on ${adapter.name}:\n` +
        `  Total: ${balance.total.toFixed(4)} ${balance.currency}\n` +
        `  Available: ${balance.available.toFixed(4)} ${balance.currency}\n` +
        `  Locked: ${balance.locked.toFixed(4)} ${balance.currency}`
    );
  }

  getAuditLog(limit: number = 50): typeof this.auditLog {
    return this.auditLog.slice(-limit);
  }

  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }
}

export default TradeTool;

