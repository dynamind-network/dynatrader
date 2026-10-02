/**
 * Chain Registry
 *
 * Centralized chain configurations with RPC URL management.
 * Supports env var overrides and falls back to public RPCs.
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem';
import {
  mainnet,
  polygon,
  bsc,
  arbitrum,
  base,
  optimism,
} from 'viem/chains';
import {
  SupportedChainId,
  type ChainConfig,
  type NativeCurrency,
} from './types';

// ---------------------------------------------------------------------------
// Chain Configurations
// ---------------------------------------------------------------------------

const CHAIN_CONFIGS: Record<SupportedChainId, ChainConfig> = {
  [SupportedChainId.ETHEREUM]: {
    chainId: SupportedChainId.ETHEREUM,
    name: 'Ethereum',
    rpcUrl: process.env['VITE_ETH_RPC'] ?? 'https://eth.llamarpc.com',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrl: 'https://etherscan.io',
    blockExplorerApiUrl: 'https://api.etherscan.io/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
  },
  [SupportedChainId.POLYGON]: {
    chainId: SupportedChainId.POLYGON,
    name: 'Polygon',
    rpcUrl: process.env['VITE_POLYGON_RPC'] ?? 'https://polygon-rpc.com',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    blockExplorerUrl: 'https://polygonscan.com',
    blockExplorerApiUrl: 'https://api.polygonscan.com/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
  },
  [SupportedChainId.BSC]: {
    chainId: SupportedChainId.BSC,
    name: 'BNB Smart Chain',
    rpcUrl: process.env['VITE_BSC_RPC'] ?? 'https://bsc-dataseed1.binance.org',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    blockExplorerUrl: 'https://bscscan.com',
    blockExplorerApiUrl: 'https://api.bscscan.com/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
  [SupportedChainId.ARBITRUM]: {
    chainId: SupportedChainId.ARBITRUM,
    name: 'Arbitrum One',
    rpcUrl: process.env['VITE_ARBITRUM_RPC'] ?? 'https://arb1.arbitrum.io/rpc',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrl: 'https://arbiscan.io',
    blockExplorerApiUrl: 'https://api.arbiscan.io/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
  },
  [SupportedChainId.BASE]: {
    chainId: SupportedChainId.BASE,
    name: 'Base',
    rpcUrl: process.env['VITE_BASE_RPC'] ?? 'https://mainnet.base.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrl: 'https://basescan.org',
    blockExplorerApiUrl: 'https://api.basescan.org/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
      swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    },
  },
  [SupportedChainId.OPTIMISM]: {
    chainId: SupportedChainId.OPTIMISM,
    name: 'Optimism',
    rpcUrl: process.env['VITE_OPTIMISM_RPC'] ?? 'https://mainnet.optimism.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrl: 'https://optimistic.etherscan.io',
    blockExplorerApiUrl: 'https://api-optimistic.etherscan.io/api',
    contracts: {
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      universalRouter: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
  },
};

// ---------------------------------------------------------------------------
// Viem Chain Mapping
// ---------------------------------------------------------------------------

// Viem Chain Mapping (cast to Chain[] to avoid literal type mismatch)
const VIEM_CHAINS: Record<SupportedChainId, Chain> = {
  [SupportedChainId.ETHEREUM]: mainnet as Chain,
  [SupportedChainId.POLYGON]: polygon as Chain,
  [SupportedChainId.BSC]: bsc as Chain,
  [SupportedChainId.ARBITRUM]: arbitrum as Chain,
  [SupportedChainId.BASE]: base as Chain,
  [SupportedChainId.OPTIMISM]: optimism as Chain,
};

// ---------------------------------------------------------------------------
// Public Client Cache
// ---------------------------------------------------------------------------

const publicClientCache = new Map<SupportedChainId, PublicClient>();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function getChainConfig(chainId: SupportedChainId): ChainConfig {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
}

export function getAllChainConfigs(): ChainConfig[] {
  return Object.values(CHAIN_CONFIGS);
}

export function getSupportedChainIds(): SupportedChainId[] {
  return Object.keys(CHAIN_CONFIGS).map(Number) as SupportedChainId[];
}

/**
 * Get or create a cached viem PublicClient for the given chain.
 * Uses the configured RPC URL with env var overrides.
 */
export function getPublicClient(chainId: SupportedChainId): PublicClient {
  const cached = publicClientCache.get(chainId);
  if (cached) return cached;

  const config = getChainConfig(chainId);
  const chain = VIEM_CHAINS[chainId];

  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl, {
      timeout: 30_000,
      retryCount: 3,
      retryDelay: 1_000,
    }),
  }) as PublicClient;

  publicClientCache.set(chainId, client);
  return client;
}

/**
 * Get the native currency info for a chain.
 */
export function getNativeCurrency(chainId: SupportedChainId): NativeCurrency {
  return getChainConfig(chainId).nativeCurrency;
}

/**
 * Format wei amount to human-readable native currency string.
 */
export function formatNativeBalance(
  chainId: SupportedChainId,
  weiAmount: bigint,
): string {
  const { decimals } = getNativeCurrency(chainId);
  const divisor = BigInt(10 ** decimals);
  const whole = weiAmount / divisor;
  const fractional = weiAmount % divisor;
  const fractionalStr = fractional.toString().padStart(decimals, '0').slice(0, 4);
  return `${whole}.${fractionalStr}`;
}

/**
 * Parse a human-readable amount to wei.
 */
export function parseToWei(
  chainId: SupportedChainId,
  amount: string,
): bigint {
  const { decimals } = getNativeCurrency(chainId);
  const [whole, fractional = ''] = amount.split('.');
  const paddedFraction = fractional.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + paddedFraction);
}
