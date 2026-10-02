/**
 * Configuration constants for trading tools
 */

import type { EvmTokenConfig } from './types.js';
import { getMarketRestBase } from '../../config/market-provider.js';

// API Endpoints
export const API_ENDPOINTS = {
  BINANCE: getMarketRestBase(),
  YAHOO_FINANCE: 'https://query1.finance.yahoo.com/v10/finance/quoteSummary',
  FOREX_API: 'https://v6.exchangerate-api.com/v6',
  HYPERLIQUID: 'https://api.hyperliquid.xyz',
  DEFI_LLAMA: 'https://api.llama.fi',
};

// RPC Endpoints - must be configured via environment variables
export const RPC_ENDPOINTS = {
  ethereum: process.env.ETH_RPC_URL || '',
  arbitrum: process.env.ARB_RPC_URL || '',
  polygon: process.env.POLYGON_RPC_URL || '',
  optimism: process.env.OPT_RPC_URL || '',
  avalanche: process.env.AVAX_RPC_URL || '',
  base: process.env.BASE_RPC_URL || '',
};

// Supported EVM Networks
export const SUPPORTED_CHAINS = [
  'ethereum',
  'arbitrum',
  'polygon',
  'optimism',
  'avalanche',
  'base',
];

// Token Registry by Chain
export const EVM_TOKEN_REGISTRY: Record<string, EvmTokenConfig[]> = {
  arbitrum: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
    { symbol: 'ARB', address: '0x912CE59144191c1204e64559fe8253a0e49e6548', decimals: 18 },
  ],
  ethereum: [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
  ],
  polygon: [
    { symbol: 'USDC', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
    { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  ],
};

// Default Parameters
export const DEFAULTS = {
  PORTFOLIO_FETCH_TIMEOUT: 30000,
  MAX_RPC_RETRIES: 3,
  RPC_RETRY_DELAY: 1000,
  HYPERLIQUID_BATCH_SIZE: 10,
  PRICE_DECIMALS: 2,
  VOLUME_DECIMALS: 2,
};

// Gas Wallet Configuration
export const GAS_WALLET_CONFIG = {
  MIN_BALANCE: {
    ethereum: 0.05, // ETH
    arbitrum: 0.01, // ARB
    polygon: 10, // MATIC
  },
  REFILL_AMOUNT: {
    ethereum: 0.1,
    arbitrum: 0.02,
    polygon: 50,
  },
};

