/**
 * Base class for wallet operation tools with shared functionality
 */

import { BaseTool } from './base-tool.js';
import type { ToolResult, ToolExecutionContext } from '../core/types.js';

export interface WalletProvider {
  getAddress(): Promise<string>;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
  sendTransaction(tx: unknown): Promise<string>;
}

export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
}

export abstract class WalletOperationTool extends BaseTool {
  protected walletProvider: WalletProvider | null = null;

  protected readonly SUPPORTED_CHAINS: Record<string, ChainConfig> = {
    ethereum: {
      name: 'Ethereum',
      chainId: 1,
      rpcUrl: process.env.ETH_RPC_URL || 'https://eth.rpc.com',
      explorer: 'https://etherscan.io',
    },
    arbitrum: {
      name: 'Arbitrum',
      chainId: 42161,
      rpcUrl: process.env.ARB_RPC_URL || 'https://arb.rpc.com',
      explorer: 'https://arbiscan.io',
    },
    polygon: {
      name: 'Polygon',
      chainId: 137,
      rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon.rpc.com',
      explorer: 'https://polygonscan.com',
    },
  };

  /**
   * Get or initialize wallet provider
   */
  protected async getWallet(): Promise<WalletProvider> {
    if (this.walletProvider) {
      return this.walletProvider;
    }

    // Initialize wallet provider (implementation-specific)
    throw new Error('Wallet not connected');
  }

  /**
   * Validate Ethereum/EVM address format
   */
  protected validateAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Validate chain name and return config
   */
  protected validateChain(chainName: string): ChainConfig | null {
    const chain = this.SUPPORTED_CHAINS[chainName.toLowerCase()];
    return chain || null;
  }

  /**
   * Switch chain if specified in parameters
   */
  protected async switchChainIfNeeded(chainName?: string): Promise<void> {
    if (!chainName) return;

    const chain = this.validateChain(chainName);
    if (!chain) {
      throw new Error(`Unknown chain: ${chainName}`);
    }

    const wallet = await this.getWallet();
    await wallet.switchChain(chain.chainId);
  }

  /**
   * Format result as JSON-stringified response
   */
  protected formatJsonResult(data: unknown): ToolResult {
    return this.success(JSON.stringify(data, null, 2));
  }

  /**
   * Validate required parameters
   */
  protected validateRequired(params: Record<string, unknown>, required: string[]): string | null {
    for (const key of required) {
      if (!params[key]) {
        return `Missing required parameter: ${key}`;
      }
    }
    return null;
  }

  /**
   * Get chain explorer URL for address
   */
  protected getExplorerUrl(chainName: string, address: string, type: 'address' | 'tx' = 'address'): string | null {
    const chain = this.validateChain(chainName);
    if (!chain) return null;

    if (type === 'address') {
      return `${chain.explorer}/address/${address}`;
    }
    return `${chain.explorer}/tx/${address}`;
  }

  /**
   * Format address with truncation
   */
  protected formatAddress(address: string, startChars = 6, endChars = 4): string {
    if (address.length <= startChars + endChars) {
      return address;
    }
    return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
  }
}
