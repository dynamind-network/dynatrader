import { BaseTool } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { NumberFormat, getErrorMessage } from '../utils/index.js';
import {
  buildMarketUrl,
  getMarketKlinesPath,
  getMarketTicker24hrPath,
  getMarketTickerPricePath,
} from '../config/market-provider.js';
import type {
  BinanceTicker,
  YahooChartResult,
  ForexApiResult,
  EvmTokenConfig,
} from './trading/types.js';

/**
 * Fetch market data from various sources
 */
export class MarketDataTool extends BaseTool {
  name = 'market_data';
  description = `Fetch live market data for crypto, stocks, and forex.
Required parameters: symbol (workspace asset, pair, or market identifier) AND type (crypto, stock, or forex).
For crypto use type="crypto", for stocks use type="stock", for forex use type="forex".
Examples: {symbol: "<crypto-symbol>", type: "crypto"}, {symbol: "<stock-symbol>", type: "stock"}, {symbol: "<fx-pair>", type: "forex"}
Sources: configured crypto market provider, Yahoo Finance (stocks), open.er-api (forex).`;
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;

  inputSchema = {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'Symbol to fetch',
      },
      type: {
        type: 'string',
        description: 'Asset type: crypto, stock, forex',
        enum: ['crypto', 'stock', 'forex'],
      },
      interval: {
        type: 'string',
        description: 'Data interval for historical data (1m, 5m, 1h, 1d)',
        enum: ['1m', '5m', '15m', '1h', '4h', '1d'],
      },
      limit: {
        type: 'number',
        description: 'Number of candles for historical data (default: 100)',
      },
    },
    required: ['symbol', 'type'],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const symbol = (input.symbol as string).toUpperCase();
    const type = input.type as string;
    const interval = (input.interval as string) || '1h';
    const limit = (input.limit as number) || 100;

    try {
      switch (type) {
        case 'crypto':
          return await this.fetchCryptoData(symbol, interval, limit);
        case 'stock':
          return await this.fetchStockData(symbol);
        case 'forex':
          return await this.fetchForexData(symbol);
        default:
          return this.error(`Unknown asset type: ${type}`);
      }
    } catch (err) {
      return this.error(`Failed to fetch market data: ${getErrorMessage(err)}`);
    }
  }

  private async fetchCryptoData(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<ToolResult> {
    const binanceSymbol = symbol.includes('USDT') ? symbol : `${symbol}USDT`;
    const url = buildMarketUrl(getMarketKlinesPath(), {
      symbol: binanceSymbol,
      interval,
      limit,
    });

    const response = await this.fetchWithTimeout(url);
    if (!response.ok) {
      const tickerUrl = buildMarketUrl(getMarketTicker24hrPath(), { symbol: binanceSymbol });
      const tickerResponse = await this.fetchWithTimeout(tickerUrl);

      if (!tickerResponse.ok) {
        return this.error(`Failed to fetch data for ${symbol}`);
      }

      const ticker = (await tickerResponse.json()) as BinanceTicker;
      return this.success(
        `${symbol} (Crypto)\n` +
          `Price: $${NumberFormat.price(parseFloat(ticker.lastPrice))}\n` +
          `24h Change: ${NumberFormat.decimal(parseFloat(ticker.priceChangePercent), 2)}%\n` +
          `24h High: $${parseFloat(ticker.highPrice).toFixed(2)}\n` +
          `24h Low: $${parseFloat(ticker.lowPrice).toFixed(2)}\n` +
          `24h Volume: ${parseFloat(ticker.volume).toLocaleString()} ${symbol}\n` +
          `24h Quote Volume: $${parseFloat(ticker.quoteVolume).toLocaleString()}`
      );
    }

    const klines = (await response.json()) as unknown[][];
    const latestCandle = klines[klines.length - 1];

    const recentCandles = klines.slice(-10).map((k) => ({
      time: new Date(k[0] as number).toISOString(),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));

    return this.success(
      `${symbol} (Crypto) - ${interval} candles\n\n` +
        `Latest:\n` +
        `  Open: $${parseFloat(latestCandle[1] as string).toFixed(2)}\n` +
        `  High: $${parseFloat(latestCandle[2] as string).toFixed(2)}\n` +
        `  Low: $${parseFloat(latestCandle[3] as string).toFixed(2)}\n` +
        `  Close: $${parseFloat(latestCandle[4] as string).toFixed(2)}\n` +
        `  Volume: ${parseFloat(latestCandle[5] as string).toLocaleString()}\n\n` +
        `Recent ${interval} candles:\n` +
        recentCandles
          .map(
            (c) =>
              `  ${c.time.split('T')[1].split('.')[0]} | $${c.close.toFixed(2)} | Vol: ${c.volume.toFixed(0)}`
          )
          .join('\n')
    );
  }

  private async fetchStockData(symbol: string): Promise<ToolResult> {
    // CRITICAL: Validate symbol format to prevent injection
    if (!symbol.match(/^[A-Z0-9.\-]{1,20}$/)) {
      return this.error('Invalid stock symbol format');
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;

    const response = await this.fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      return this.error(`Failed to fetch stock data for ${symbol}`);
    }

    const data = (await response.json()) as YahooChartResult;
    const result = data.chart.result?.[0];

    if (!result) {
      return this.error(`No data found for ${symbol}`);
    }

    const meta = result.meta;
    const quote = result.indicators.quote[0];
    const latestIdx = quote.close.length - 1;

    return this.success(
      `${symbol} (${meta.shortName || 'Stock'})\n` +
        `Price: $${meta.regularMarketPrice?.toFixed(2) || quote.close[latestIdx]?.toFixed(2)}\n` +
        `Previous Close: $${meta.previousClose?.toFixed(2)}\n` +
        `Day Range: $${meta.regularMarketDayLow?.toFixed(2)} - $${meta.regularMarketDayHigh?.toFixed(2)}\n` +
        `52 Week Range: $${meta.fiftyTwoWeekLow?.toFixed(2)} - $${meta.fiftyTwoWeekHigh?.toFixed(2)}\n` +
        `Volume: ${meta.regularMarketVolume?.toLocaleString()}\n` +
        `Market Cap: $${meta.marketCap ? (meta.marketCap / 1e9).toFixed(2) + 'B' : 'N/A'}`
    );
  }

  private async fetchForexData(symbol: string): Promise<ToolResult> {
    const pair = symbol.replace('/', '').toUpperCase();
    const base = pair.substring(0, 3);
    const quote = pair.substring(3, 6) || 'USD';

    // CRITICAL: Validate forex pair format
    if (!base.match(/^[A-Z]{3}$/) || !quote.match(/^[A-Z]{3}$/)) {
      return this.error('Invalid forex pair format');
    }

    const url = `https://open.er-api.com/v6/latest/${base}`;

    const response = await this.fetchWithTimeout(url);
    if (!response.ok) {
      return this.error(`Failed to fetch forex data for ${symbol}`);
    }

    const data = (await response.json()) as ForexApiResult;

    if (data.result !== 'success') {
      return this.error(`Forex data error: ${data.error || 'Unknown error'}`);
    }

    const rate = data.rates[quote];
    if (!rate) {
      return this.error(`No rate found for ${base}/${quote}`);
    }

    return this.success(
      `${base}/${quote} (Forex)\n` +
        `Rate: ${rate.toFixed(5)}\n` +
        `Last Updated: ${data.time_last_update_utc}\n` +
        `Base: ${base}\n` +
        `Quote: ${quote}`
    );
  }

  private async fetchWithTimeout(url: string, options?: RequestInit, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Hyperliquid API types
interface HyperliquidPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  leverage: {
    type: string;
    value: number;
  };
  liquidationPx: string | null;
}

interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
  withdrawable: string;
}

interface HyperliquidUserState {
  assetPositions: Array<{
    position: HyperliquidPosition;
    type: string;
  }>;
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary: HyperliquidMarginSummary;
}

/**
 * Portfolio tracking tool - fetches real positions from Hyperliquid, EVM wallets, Curve, Aave
 */
export class PortfolioTool extends BaseTool {
  name = 'portfolio';
  description =
    'View portfolio state across Hyperliquid perps, EVM wallets, Curve LPs, and Aave lending. Required: action ("view", "full", "add", "remove", "analyze"). Examples: {action: "view"}, {action: "full"}, {action: "analyze"}. Use when user asks about balances, positions, holdings, exposure, allocation, or portfolio.';
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;

  inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: ['view', 'full', 'add', 'remove', 'analyze'],
      },
      symbol: {
        type: 'string',
        description: 'Symbol for add/remove actions (stocks, manual entries)',
      },
      quantity: {
        type: 'number',
        description: 'Quantity for add/remove actions',
      },
      entry_price: {
        type: 'number',
        description: 'Entry price for add action',
      },
    },
    required: ['action'],
  };

  // Manual positions (stocks, other assets not on Hyperliquid or EVM)
  private static manualPortfolio: Map<
    string,
    { quantity: number; entryPrice: number; timestamp: number; type: string }
  > = new Map();

  // Hyperliquid API endpoint
  private readonly HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

  // User address from environment
  private getUserAddress(): string {
    // CRITICAL: Return empty string to properly detect missing configuration
    const addr = process.env.USER_ADDRESS || process.env.MAIN_ADDRESS;
    if (!addr || !addr.trim()) return '';

    // CRITICAL: Validate the address is a proper Ethereum address
    const trimmed = addr.trim();
    if (!trimmed.match(/^0x[0-9a-fA-F]{40}$/)) {
      console.warn(`[security] Invalid USER_ADDRESS format: not a valid Ethereum address`);
      return '';
    }
    return trimmed;
  }

  /**
   * CRITICAL: Fetch with timeout to prevent hanging on unresponsive endpoints.
   */
  private async fetchWithTimeout(url: string, options?: RequestInit, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // EVM RPC endpoints
  private readonly EVM_RPCS: Record<string, string> = {
    ethereum: 'https://eth.llamarpc.com',
    arbitrum: 'https://arb1.arbitrum.io/rpc',
    polygon: 'https://polygon-rpc.com',
    base: 'https://mainnet.base.org',
    optimism: 'https://mainnet.optimism.io',
  };

  // Token contracts per chain
  private readonly TOKEN_CONTRACTS: Record<string, EvmTokenConfig[]> = {
    arbitrum: [
      {
        symbol: 'USDC',
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
      },
      {
        symbol: 'USDT',
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        decimals: 6,
      },
      {
        symbol: 'WETH',
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        decimals: 18,
      },
    ],
    ethereum: [
      {
        symbol: 'USDC',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
      },
      {
        symbol: 'USDT',
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals: 6,
      },
      {
        symbol: 'WETH',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
      },
    ],
    polygon: [
      {
        symbol: 'USDC',
        address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        decimals: 6,
      },
      {
        symbol: 'USDT',
        address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        decimals: 6,
      },
    ],
    base: [
      {
        symbol: 'USDC',
        address: '0xd9aAEc86CE65be6B6f312d46Ae46F4e45346e8Bf',
        decimals: 6,
      },
      {
        symbol: 'WETH',
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
      },
    ],
    optimism: [
      {
        symbol: 'USDC',
        address: '0x0b2C639c533813f4Aa9D7837CAf62653E096aE50',
        decimals: 6,
      },
      {
        symbol: 'USDT',
        address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        decimals: 6,
      },
    ],
  };

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolResult> {
    const action = input.action as string;

    switch (action) {
      case 'view':
        return this.viewFullPortfolio();
      case 'full':
        return this.viewAggregatedPortfolio();
      case 'add':
        return this.addManualPosition(input);
      case 'remove':
        return this.removeManualPosition(input);
      case 'analyze':
        return this.analyzeFullPortfolio();
      default:
        return this.error(`Unknown action: ${action}`);
    }
  }

  private async viewFullPortfolio(): Promise<ToolResult> {
    const userAddress = this.getUserAddress();
    const output: string[] = [];
    const { hlLines, hlValue, hlPnl } = await this.buildHyperliquidSection(userAddress);
    const { evmLines, evmValue } = await this.buildEvmSection(userAddress);
    const { manualLines, manualValue } = this.buildManualSection();

    const totalValue = hlValue + evmValue + manualValue;
    output.push(...hlLines, '', ...evmLines, '', ...manualLines, '');
    output.push('=== PORTFOLIO SUMMARY ===');
    output.push(`Total Portfolio Value: $${totalValue.toFixed(2)}`);
    if (hlPnl !== 0) output.push(`Unrealized PnL (Hyperliquid): $${hlPnl.toFixed(2)}`);

    return this.success(output.join('\n'));
  }

  private async buildHyperliquidSection(userAddress: string | null) {
    const lines = ['=== HYPERLIQUID PERPETUALS ==='];
    let value = 0,
      pnl = 0;

    if (!userAddress) {
      lines.push('(No USER_ADDRESS configured - skipping Hyperliquid)');
      return { hlLines: lines, hlValue: value, hlPnl: pnl };
    }

    try {
      const hlData = await this.fetchHyperliquidPositions(userAddress);
      if (!hlData) return { hlLines: lines, hlValue: value, hlPnl: pnl };

      const accountValue = parseFloat(hlData.marginSummary?.accountValue || '0');
      const withdrawable = parseFloat(hlData.marginSummary?.withdrawable || '0');
      const marginUsed = parseFloat(hlData.marginSummary?.totalMarginUsed || '0');

      lines.push(`Account Value: $${accountValue.toFixed(2)}`);
      lines.push(`Available Balance: $${withdrawable.toFixed(2)}`);
      lines.push(`Margin Used: $${marginUsed.toFixed(2)}`);
      lines.push('');

      value = accountValue;
      const positions = hlData.assetPositions || [];

      if (positions.length === 0) {
        lines.push('No open positions');
      } else {
        lines.push('Open Positions:');
        for (const item of positions) {
          const pos = item.position;
          const size = parseFloat(pos.szi);
          if (size === 0) continue;

          const entryPx = parseFloat(pos.entryPx);
          const posValue = parseFloat(pos.positionValue);
          const positionPnl = parseFloat(pos.unrealizedPnl);
          const roe = parseFloat(pos.returnOnEquity) * 100;
          const leverage = pos.leverage?.value || 1;
          const liqPx = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null;
          const side = size > 0 ? 'LONG' : 'SHORT';

          pnl += positionPnl;
          lines.push(`  ${pos.coin} ${side}`);
          lines.push(`    Size: ${Math.abs(size).toFixed(4)} | Entry: $${entryPx.toFixed(2)}`);
          lines.push(`    Value: $${Math.abs(posValue).toFixed(2)} | Leverage: ${leverage}x`);
          lines.push(
            `    PnL: $${positionPnl.toFixed(2)} (${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%)`
          );
          if (liqPx) lines.push(`    Liquidation: $${liqPx.toFixed(2)}`);
          lines.push('');
        }
      }
    } catch (err) {
      // CRITICAL: Sanitize error messages to prevent leaking API keys, addresses, or internal details
      const errMsg = getErrorMessage(err);
      const sanitized = errMsg
        .replace(/[a-f0-9]{32,}/gi, '[REDACTED]')        // Redact potential keys/hashes
        .replace(/0x[a-fA-F0-9]{40}/g, '[ADDRESS]')       // Redact Ethereum addresses
        .replace(/api[_-]?key[^,]*/gi, '[API_KEY]')       // Redact API key references
        .replace(/secret[^,]*/gi, '[SECRET]')              // Redact secret references
        .replace(/password[^,]*/gi, '[PASSWORD]')          // Redact password references
        .replace(/bearer\s+[^\s,]+/gi, '[TOKEN]')         // Redact bearer tokens
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]'); // Redact IP addresses
      lines.push(`Error fetching Hyperliquid data: ${sanitized}`);
    }

    return { hlLines: lines, hlValue: value, hlPnl: pnl };
  }

  private async buildEvmSection(userAddress: string | null) {
    const lines = ['=== EVM WALLET BALANCES ==='];
    let value = 0;

    if (!userAddress) {
      lines.push('(No USER_ADDRESS configured - skipping EVM wallets)');
      return { evmLines: lines, evmValue: value };
    }

    try {
      const evmBalances = await this.fetchEvmBalances(userAddress);
      if (evmBalances.length === 0) {
        lines.push('No EVM balances found');
      } else {
        for (const bal of evmBalances) {
          if (parseFloat(bal.balance) > 0.0001) {
            lines.push(`  ${bal.chain}: ${parseFloat(bal.balance).toFixed(4)} ${bal.symbol}`);
            if (bal.valueUsd && bal.valueUsd > 0) {
              lines.push(`    Value: $${bal.valueUsd.toFixed(2)}`);
              value += bal.valueUsd;
            }
          }
        }
      }
    } catch (err) {
      lines.push(`Error fetching EVM balances: ${getErrorMessage(err)}`);
    }

    return { evmLines: lines, evmValue: value };
  }

  private buildManualSection() {
    const lines = ['=== MANUAL POSITIONS (Stocks, Other) ==='];
    let value = 0;

    if (PortfolioTool.manualPortfolio.size === 0) {
      lines.push('No manual positions tracked');
      lines.push('(Use "portfolio add SYMBOL QTY PRICE" to add stocks/other assets)');
    } else {
      for (const [symbol, pos] of PortfolioTool.manualPortfolio) {
        const itemValue = pos.quantity * pos.entryPrice;
        lines.push(`  ${symbol} (${pos.type}): ${pos.quantity} @ $${pos.entryPrice.toFixed(2)}`);
        lines.push(`    Cost Basis: $${itemValue.toFixed(2)}`);
        value += itemValue;
      }
    }

    return { manualLines: lines, manualValue: value };
  }

  /**
   * Aggregated portfolio view with PnL% across all platforms
   */
  private async viewAggregatedPortfolio(): Promise<ToolResult> {
    const userAddress = this.getUserAddress();
    if (!userAddress) {
      return this.error(
        'No USER_ADDRESS configured. Set USER_ADDRESS or WALLET_ADDRESS environment variable.'
      );
    }

    interface PlatformSummary {
      name: string;
      value: number;
      pnl: number;
      pnlPercent: number;
      positions: Array<{
        asset: string;
        value: number;
        pnl: number;
        pnlPercent: number;
        extra?: string;
      }>;
    }

    const platforms = await this.aggregatePlatforms(userAddress);
    const [grandTotalValue, grandTotalPnl] = platforms.reduce(
      ([val, pnl], p) => [val + p.value, pnl + p.pnl],
      [0, 0]
    );

    return this.success(this.formatPortfolioOutput(platforms, grandTotalValue, grandTotalPnl));
  }

  /**
   * Aggregate data from all portfolio platforms
   */
  private async aggregatePlatforms(userAddress: string) {
    interface PlatformSummary {
      name: string;
      value: number;
      pnl: number;
      pnlPercent: number;
      positions: Array<{
        asset: string;
        value: number;
        pnl: number;
        pnlPercent: number;
        extra?: string;
      }>;
    }
    const platforms: PlatformSummary[] = [];

    await this.tryAddHyperliquids(platforms, userAddress);
    await this.tryAddCurve(platforms, userAddress);
    await this.tryAddAave(platforms, userAddress);
    await this.tryAddEvmWallets(platforms, userAddress);

    return platforms;
  }

  private async tryAddHyperliquids(platforms: any[], userAddress: string) {
    try {
      const hlData = await this.fetchHyperliquidPositions(userAddress);
      if (!hlData) return;

      const accountValue = parseFloat(hlData.marginSummary?.accountValue || '0');
      let hlPnl = 0;
      const positions = [];

      for (const item of hlData.assetPositions || []) {
        const pos = item.position;
        const size = parseFloat(pos.szi);
        if (size === 0) continue;

        const pnl = parseFloat(pos.unrealizedPnl);
        hlPnl += pnl;
        positions.push({
          asset: `${pos.coin} ${size > 0 ? 'LONG' : 'SHORT'}`,
          value: Math.abs(parseFloat(pos.positionValue)),
          pnl,
          pnlPercent: parseFloat(pos.returnOnEquity) * 100,
          extra: `${parseFloat(String(pos.leverage?.value || '1'))}x`,
        });
      }

      platforms.push({
        name: 'HYPERLIQUID',
        value: accountValue,
        pnl: hlPnl,
        pnlPercent: accountValue > hlPnl ? (hlPnl / (accountValue - hlPnl)) * 100 : 0,
        positions,
      });
    } catch (err) {
      /* Skip on error */
    }
  }

  private async tryAddCurve(platforms: any[], userAddress: string) {
    try {
      const curveData = await this.fetchCurvePositions(userAddress);
      if (!curveData || curveData.totalValueUsd <= 0) return;

      platforms.push({
        name: 'CURVE',
        value: curveData.totalValueUsd,
        pnl: 0,
        pnlPercent: 0,
        positions: curveData.positions.map((p: any) => ({
          asset: p.poolName || p.pool,
          value: p.totalValueUsd,
          pnl: 0,
          pnlPercent: 0,
        })),
      });
    } catch (err) {
      /* Skip on error */
    }
  }

  private async tryAddAave(platforms: any[], userAddress: string) {
    try {
      const aaveData = await this.fetchAavePositions(userAddress);
      if (!aaveData || aaveData.summary.netValueUsd <= 0) return;

      const positions = [];
      for (const pos of aaveData.supplyPositions || [])
        positions.push({
          asset: `Supply ${pos.asset}`,
          value: pos.valueUsd,
          pnl: 0,
          pnlPercent: 0,
        });
      for (const pos of aaveData.borrowPositions || [])
        positions.push({
          asset: `Borrow ${pos.asset}`,
          value: -pos.valueUsd,
          pnl: 0,
          pnlPercent: 0,
        });

      platforms.push({
        name: 'AAVE',
        value: aaveData.summary.netValueUsd,
        pnl: 0,
        pnlPercent: 0,
        positions,
      });
    } catch (err) {
      /* Skip on error */
    }
  }

  private async tryAddEvmWallets(platforms: any[], userAddress: string) {
    try {
      const evmBalances = await this.fetchEvmBalances(userAddress);
      let evmTotal = 0;
      const positions = [];

      for (const bal of evmBalances) {
        if (bal.valueUsd && bal.valueUsd > 0.01) {
          evmTotal += bal.valueUsd;
          positions.push({
            asset: `${bal.symbol} (${bal.chain})`,
            value: bal.valueUsd,
            pnl: 0,
            pnlPercent: 0,
          });
        }
      }

      if (evmTotal > 0)
        platforms.push({
          name: 'EVM WALLETS',
          value: evmTotal,
          pnl: 0,
          pnlPercent: 0,
          positions,
        });
    } catch (err) {
      /* Skip on error */
    }
  }

  private formatPortfolioOutput(
    platforms: any[],
    grandTotalValue: number,
    grandTotalPnl: number
  ): string {
    const output: string[] = [];
    const pnlPercent =
      grandTotalValue > 0 && grandTotalPnl !== 0
        ? (grandTotalPnl / (grandTotalValue - grandTotalPnl)) * 100
        : 0;

    output.push('PORTFOLIO SUMMARY');
    output.push('='.repeat(50));
    output.push(
      `Current Portfolio Value: $${grandTotalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    );
    output.push(
      `Total PnL: ${NumberFormat.pnl(grandTotalPnl)} (${NumberFormat.pnlPercent(pnlPercent)})`
    );
    output.push('');
    output.push('Allocation Breakdown:');

    for (const platform of platforms) {
      const pnlStr =
        platform.pnl !== 0
          ? ` ${NumberFormat.pnl(platform.pnl, '$')} (${NumberFormat.pnlPercent(platform.pnlPercent)})`
          : '';
      output.push(
        `- ${platform.name}: $${platform.value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}${pnlStr}`
      );

      for (const pos of platform.positions) {
        const posPnlStr = pos.pnl !== 0 ? ` ${NumberFormat.pnl(pos.pnl, '$')}` : '';
        const extraStr = pos.extra ? ` [${pos.extra}]` : '';
        output.push(`  • ${pos.asset}: $${pos.value.toFixed(0)}${posPnlStr}${extraStr}`);
      }
      output.push('');
    }

    return output.join('\n');
  }

  private async fetchCurvePositions(userAddress: string): Promise<any> {
    // Fetch Curve positions
    const CURVE_API = 'https://api.curve.fi/api';
    const ARBITRUM_POOLS: Record<string, { name: string; address: string }> = {
      '2pool': {
        name: 'Curve 2pool',
        address: '0x7f90122BF0700F9E7e1F688fe926940E8839F353',
      },
      tricrypto: {
        name: 'Curve Tricrypto',
        address: '0x960ea3e3C7FB317332d990873d354E18d7645590',
      },
    };

    const positions: Array<{
      pool: string;
      poolName: string;
      totalValueUsd: number;
    }> = [];
    let totalValueUsd = 0;

    // Get pool prices
    const poolDataResponse = await fetch(`${CURVE_API}/getPools/arbitrum/main`);
    const poolData = (await poolDataResponse.json()) as {
      success: boolean;
      data: { poolData: any[] };
    };
    const poolPrices = new Map<string, number>();

    if (poolData.success && poolData.data?.poolData) {
      for (const pool of poolData.data.poolData) {
        if (pool.lpTokenAddress && pool.usdTotal && pool.totalSupply) {
          const lpPrice = pool.usdTotal / parseFloat(pool.totalSupply);
          poolPrices.set(pool.lpTokenAddress.toLowerCase(), lpPrice);
        }
      }
    }

    // Check LP balances
    for (const [poolId, poolInfo] of Object.entries(ARBITRUM_POOLS)) {
      try {
        const balance = await this.fetchTokenBalanceBigInt(
          'https://arb1.arbitrum.io/rpc',
          userAddress,
          poolInfo.address
        );
        if (balance > 0n) {
          const balanceFormatted = Number(balance) / 1e18;
          const lpPrice = poolPrices.get(poolInfo.address.toLowerCase()) || 1;
          const valueUsd = balanceFormatted * lpPrice;

          if (valueUsd > 0.01) {
            positions.push({
              pool: poolId,
              poolName: poolInfo.name,
              totalValueUsd: valueUsd,
            });
            totalValueUsd += valueUsd;
          }
        }
      } catch {
        // Skip
      }
    }

    return { totalValueUsd, positions };
  }

  private async fetchAavePositions(userAddress: string): Promise<any> {
    // Fetch Aave positions
    const AAVE_TOKENS: Record<string, { symbol: string; aToken: string; decimals: number }> = {
      USDC: {
        symbol: 'USDC',
        aToken: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
        decimals: 6,
      },
      WETH: {
        symbol: 'WETH',
        aToken: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8',
        decimals: 18,
      },
    };

    const DEBT_TOKENS: Record<string, { symbol: string; vToken: string; decimals: number }> = {
      USDC: {
        symbol: 'USDC',
        vToken: '0xFCCf3cAbbe80101232d343252614b6A3eE81C989',
        decimals: 6,
      },
    };

    const prices = await this.fetchTokenPrices();
    const supplyPositions: Array<{ asset: string; valueUsd: number }> = [];
    const borrowPositions: Array<{ asset: string; valueUsd: number }> = [];
    let totalSupplyUsd = 0;
    let totalBorrowUsd = 0;

    // Supply positions
    for (const [, tokenInfo] of Object.entries(AAVE_TOKENS)) {
      try {
        const balance = await this.fetchTokenBalanceBigInt(
          'https://arb1.arbitrum.io/rpc',
          userAddress,
          tokenInfo.aToken
        );
        if (balance > 0n) {
          const balanceFormatted = Number(balance) / Math.pow(10, tokenInfo.decimals);
          const price = tokenInfo.symbol === 'WETH' ? prices.ETH : 1;
          const valueUsd = balanceFormatted * price;

          if (valueUsd > 0.01) {
            supplyPositions.push({ asset: tokenInfo.symbol, valueUsd });
            totalSupplyUsd += valueUsd;
          }
        }
      } catch {
        // Skip
      }
    }

    // Borrow positions
    for (const [, tokenInfo] of Object.entries(DEBT_TOKENS)) {
      try {
        const balance = await this.fetchTokenBalanceBigInt(
          'https://arb1.arbitrum.io/rpc',
          userAddress,
          tokenInfo.vToken
        );
        if (balance > 0n) {
          const balanceFormatted = Number(balance) / Math.pow(10, tokenInfo.decimals);
          const valueUsd = balanceFormatted; // Stablecoin

          if (valueUsd > 0.01) {
            borrowPositions.push({ asset: tokenInfo.symbol, valueUsd });
            totalBorrowUsd += valueUsd;
          }
        }
      } catch {
        // Skip
      }
    }

    return {
      summary: {
        totalSupplyUsd,
        totalBorrowUsd,
        netValueUsd: totalSupplyUsd - totalBorrowUsd,
      },
      supplyPositions,
      borrowPositions,
    };
  }

  private async fetchTokenBalanceBigInt(
    rpcUrl: string,
    address: string,
    tokenAddress: string
  ): Promise<bigint> {
    // CRITICAL: Validate token address is a valid Ethereum address before making RPC call
    if (!tokenAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new Error(`Invalid token address: ${tokenAddress}`);
    }

    const data = '0x70a08231' + address.slice(2).padStart(64, '0');

    const response = await this.fetchWithTimeout(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: tokenAddress, data }, 'latest'],
      }),
    });

    const result = (await response.json()) as { result?: string };
    if (!result.result || result.result === '0x') {
      return 0n;
    }

    return BigInt(result.result);
  }

  private async fetchHyperliquidPositions(
    userAddress: string
  ): Promise<HyperliquidUserState | null> {
    const payload = {
      type: 'clearinghouseState',
      user: userAddress,
    };

    const response = await this.fetchWithTimeout(this.HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid API error: ${response.status}`);
    }

    return (await response.json()) as HyperliquidUserState;
  }

  private async fetchEvmBalances(
    userAddress: string
  ): Promise<Array<{ chain: string; symbol: string; balance: string; valueUsd?: number }>> {
    const balances: Array<{
      chain: string;
      symbol: string;
      balance: string;
      valueUsd?: number;
    }> = [];
    const prices = await this.fetchTokenPrices();

    for (const [chain, rpcUrl] of Object.entries(this.EVM_RPCS))
      await this.processChainBalances(chain, rpcUrl, userAddress, prices, balances);

    return balances;
  }

  private async processChainBalances(
    chain: string,
    rpcUrl: string,
    userAddress: string,
    prices: { ETH: number; MATIC: number },
    balances: Array<{
      chain: string;
      symbol: string;
      balance: string;
      valueUsd?: number;
    }>
  ) {
    try {
      const nativeBalance = await this.fetchNativeBalance(rpcUrl, userAddress);
      if (nativeBalance && parseFloat(nativeBalance) > 0) {
        const nativeSymbol = chain === 'polygon' ? 'MATIC' : 'ETH';
        const price = nativeSymbol === 'MATIC' ? prices.MATIC : prices.ETH;
        balances.push({
          chain,
          symbol: nativeSymbol,
          balance: nativeBalance,
          valueUsd: parseFloat(nativeBalance) * price || undefined,
        });
      }

      const tokens = this.TOKEN_CONTRACTS[chain] || [];
      for (const token of tokens)
        await this.processTokenBalance(chain, token, rpcUrl, userAddress, prices, balances);
    } catch {
      /* Skip failed chain */
    }
  }

  private async processTokenBalance(
    chain: string,
    token: any,
    rpcUrl: string,
    userAddress: string,
    prices: { ETH: number; MATIC: number },
    balances: Array<{
      chain: string;
      symbol: string;
      balance: string;
      valueUsd?: number;
    }>
  ) {
    try {
      const tokenBalance = await this.fetchTokenBalance(
        rpcUrl,
        userAddress,
        token.address,
        token.decimals
      );
      if (tokenBalance && parseFloat(tokenBalance) > 0) {
        const valueUsd = token.symbol.includes('USD')
          ? parseFloat(tokenBalance)
          : token.symbol === 'WETH'
            ? parseFloat(tokenBalance) * prices.ETH
            : undefined;
        balances.push({
          chain,
          symbol: token.symbol,
          balance: tokenBalance,
          valueUsd,
        });
      }
    } catch {
      /* Skip failed token */
    }
  }

  private async fetchTokenPrices(): Promise<{ ETH: number; MATIC: number }> {
    const prices = { ETH: 0, MATIC: 0 };
    let hasError = false;

    try {
      const ethResponse = await this.fetchWithTimeout(
        buildMarketUrl(getMarketTickerPricePath(), { symbol: 'ETHUSDT' })
      );
      if (ethResponse.ok) {
        const ethData = (await ethResponse.json()) as { price: string };
        prices.ETH = parseFloat(ethData.price);
      } else {
        hasError = true;
      }
    } catch {
      hasError = true;
    }

    try {
      const maticResponse = await this.fetchWithTimeout(
        buildMarketUrl(getMarketTickerPricePath(), { symbol: 'MATICUSDT' })
      );
      if (maticResponse.ok) {
        const maticData = (await maticResponse.json()) as { price: string };
        prices.MATIC = parseFloat(maticData.price);
      } else {
        hasError = true;
      }
    } catch {
      hasError = true;
    }

    if (prices.ETH === 0 || prices.MATIC === 0) {
      throw new Error('Failed to fetch token prices from the market API');
    }

    return prices;
  }

  private async fetchNativeBalance(rpcUrl: string, address: string): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getBalance',
          params: [address, 'latest'],
          id: 1,
        }),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { result?: string };
      if (!data.result) return null;

      // Convert hex wei to ETH
      const weiValue = BigInt(data.result);
      const ethValue = Number(weiValue) / 1e18;
      return ethValue.toFixed(6);
    } catch {
      return null;
    }
  }

  private async fetchTokenBalance(
    rpcUrl: string,
    address: string,
    tokenAddress: string,
    decimals: number
  ): Promise<string | null> {
    try {
      // CRITICAL: Validate token address format
      if (!tokenAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
        return null;
      }

      // balanceOf(address) function selector
      const data = '0x70a08231' + address.slice(2).padStart(64, '0');

      const response = await this.fetchWithTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: tokenAddress, data }, 'latest'],
          id: 1,
        }),
      });

      if (!response.ok) return null;

      const result = (await response.json()) as { result?: string };
      if (!result.result || result.result === '0x') return null;

      const balance = BigInt(result.result);
      const formatted = Number(balance) / Math.pow(10, decimals);
      return formatted.toFixed(decimals === 6 ? 2 : 6);
    } catch {
      return null;
    }
  }

  private addManualPosition(input: Record<string, unknown>): ToolResult {
    const symbol = (input.symbol as string)?.toUpperCase();
    const quantity = input.quantity as number;
    const entryPrice = input.entry_price as number;

    if (!symbol || !quantity || !entryPrice) {
      return this.error('Missing required fields: symbol, quantity, entry_price');
    }

    const existing = PortfolioTool.manualPortfolio.get(symbol);
    if (existing) {
      const totalQty = existing.quantity + quantity;
      const avgPrice = (existing.quantity * existing.entryPrice + quantity * entryPrice) / totalQty;
      PortfolioTool.manualPortfolio.set(symbol, {
        quantity: totalQty,
        entryPrice: avgPrice,
        timestamp: Date.now(),
        type: existing.type,
      });
    } else {
      PortfolioTool.manualPortfolio.set(symbol, {
        quantity,
        entryPrice,
        timestamp: Date.now(),
        type: 'stock',
      });
    }

    return this.success(
      `Added ${quantity} ${symbol} @ $${entryPrice.toFixed(2)} to manual portfolio`
    );
  }

  private removeManualPosition(input: Record<string, unknown>): ToolResult {
    const symbol = (input.symbol as string)?.toUpperCase();
    const quantity = input.quantity as number;

    if (!symbol) {
      return this.error('Missing required field: symbol');
    }

    const existing = PortfolioTool.manualPortfolio.get(symbol);
    if (!existing) {
      return this.error(`No manual position found for ${symbol}`);
    }

    if (quantity && quantity < existing.quantity) {
      existing.quantity -= quantity;
      return this.success(`Removed ${quantity} ${symbol} from manual portfolio`);
    } else {
      PortfolioTool.manualPortfolio.delete(symbol);
      return this.success(`Closed manual position in ${symbol}`);
    }
  }

  private async analyzeFullPortfolio(): Promise<ToolResult> {
    const output: string[] = ['=== PORTFOLIO ANALYSIS ===', ''];
    const userAddress = this.getUserAddress();

    let hlAccountValue = 0;
    let hlPositionCount = 0;
    let hlTotalPnl = 0;
    let evmTotalValue = 0;
    let manualTotalValue = 0;

    // Analyze Hyperliquid
    if (userAddress) {
      try {
        const hlData = await this.fetchHyperliquidPositions(userAddress);
        if (hlData) {
          hlAccountValue = parseFloat(hlData.marginSummary?.accountValue || '0');
          const positions = hlData.assetPositions || [];
          for (const item of positions) {
            const size = parseFloat(item.position.szi);
            if (size !== 0) {
              hlPositionCount++;
              hlTotalPnl += parseFloat(item.position.unrealizedPnl);
            }
          }
        }
      } catch {
        output.push('Could not fetch Hyperliquid data for analysis');
      }
    }

    // Analyze EVM
    if (userAddress) {
      try {
        const evmBalances = await this.fetchEvmBalances(userAddress);
        for (const bal of evmBalances) {
          if (bal.valueUsd) {
            evmTotalValue += bal.valueUsd;
          }
        }
      } catch {
        output.push('Could not fetch EVM data for analysis');
      }
    }

    // Analyze Manual
    for (const [, pos] of PortfolioTool.manualPortfolio) {
      manualTotalValue += pos.quantity * pos.entryPrice;
    }

    const totalValue = hlAccountValue + evmTotalValue + manualTotalValue;

    output.push('Allocation Breakdown:');
    output.push(
      `  Hyperliquid: $${hlAccountValue.toFixed(2)} (${totalValue > 0 ? ((hlAccountValue / totalValue) * 100).toFixed(1) : 0}%)`
    );
    output.push(`    - Open Positions: ${hlPositionCount}`);
    output.push(`    - Unrealized PnL: $${hlTotalPnl.toFixed(2)}`);
    output.push(
      `  EVM Wallets: $${evmTotalValue.toFixed(2)} (${totalValue > 0 ? ((evmTotalValue / totalValue) * 100).toFixed(1) : 0}%)`
    );
    output.push(
      `  Manual/Stocks: $${manualTotalValue.toFixed(2)} (${totalValue > 0 ? ((manualTotalValue / totalValue) * 100).toFixed(1) : 0}%)`
    );
    output.push('');
    output.push(`Total Portfolio Value: $${totalValue.toFixed(2)}`);

    return this.success(output.join('\n'));
  }
}

