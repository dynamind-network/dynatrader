// Blockchain chain configurations

export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export const SUPPORTED_EVM_CHAINS = [
  'ethereum',
  'polygon',
  'base',
  'arbitrum',
  'optimism',
  'bsc',
  'avalanche',
] as const;

export type SupportedChain = (typeof SUPPORTED_EVM_CHAINS)[number];

/**
 * Get chain configuration by name
 */
export function getChainConfig(chainName: string): ChainConfig | undefined {
  const configs: Record<string, ChainConfig> = {
    ethereum: {
      name: 'Ethereum',
      chainId: 1,
      rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
      explorerUrl: 'https://etherscan.io',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
    },
    polygon: {
      name: 'Polygon',
      chainId: 137,
      rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      explorerUrl: 'https://polygonscan.com',
      nativeCurrency: {
        name: 'MATIC',
        symbol: 'MATIC',
        decimals: 18,
      },
    },
    base: {
      name: 'Base',
      chainId: 8453,
      rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      explorerUrl: 'https://basescan.org',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
    },
    arbitrum: {
      name: 'Arbitrum One',
      chainId: 42161,
      rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
      explorerUrl: 'https://arbiscan.io',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
    },
    optimism: {
      name: 'Optimism',
      chainId: 10,
      rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
      explorerUrl: 'https://optimistic.etherscan.io',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
    },
    bsc: {
      name: 'BNB Chain',
      chainId: 56,
      rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
      explorerUrl: 'https://bscscan.com',
      nativeCurrency: {
        name: 'BNB',
        symbol: 'BNB',
        decimals: 18,
      },
    },
    avalanche: {
      name: 'Avalanche',
      chainId: 43114,
      rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
      explorerUrl: 'https://snowtrace.io',
      nativeCurrency: {
        name: 'AVAX',
        symbol: 'AVAX',
        decimals: 18,
      },
    },
  };

  return configs[chainName.toLowerCase()];
}

/**
 * Format an address for display (truncate middle)
 */
export function formatAddress(address: string): string {
  if (!address || address.length < 10) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Validate an address format
 */
export function isValidAddress(address: string): boolean {
  if (!address) {
    return false;
  }
  // Basic Ethereum address validation
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Get chain ID by name
 */
export function getChainId(chainName: string): number | undefined {
  return getChainConfig(chainName)?.chainId;
}

/**
 * Get chain name by ID
 */
export function getChainName(chainId: number): string | undefined {
  for (const chain of SUPPORTED_EVM_CHAINS) {
    const config = getChainConfig(chain);
    if (config?.chainId === chainId) {
      return chain;
    }
  }
  return undefined;
}
