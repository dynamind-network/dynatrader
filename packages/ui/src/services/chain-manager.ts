import { ethers } from 'ethers';
import { SUPPORTED_EVM_CHAINS, getChainConfig } from '../utils/chains.js';

export class ChainManager {
  private evmProviders: Map<string, ethers.JsonRpcProvider> = new Map();

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders() {
    for (const chainName of SUPPORTED_EVM_CHAINS) {
      const config = getChainConfig(chainName);
      if (config?.rpcUrl) {
        try {
          const provider = new ethers.JsonRpcProvider(config.rpcUrl);
          this.evmProviders.set(chainName, provider);
        } catch (error) {
          console.error(`Failed to initialize provider for ${chainName}:`, error);
        }
      }
    }
  }

  getEvmProvider(chainName: string): ethers.JsonRpcProvider | undefined {
    return this.evmProviders.get(chainName.toLowerCase());
  }

  async getBalance(chainName: string, address: string): Promise<string> {
    const provider = this.getEvmProvider(chainName);
    if (!provider) throw new Error(`Provider not found for chain: ${chainName}`);

    try {
      const balance = await provider.getBalance(address);
      return balance.toString();
    } catch (error) {
      console.error(`Failed to get EVM balance for ${address} on ${chainName}:`, error);
      throw error;
    }
  }

  async getTransactionCount(chainName: string, address: string): Promise<number> {
    const provider = this.getEvmProvider(chainName);
    if (!provider) throw new Error(`Provider not found for chain: ${chainName}`);

    try {
      return await provider.getTransactionCount(address);
    } catch (error) {
      console.error(`Failed to get transaction count for ${address} on ${chainName}:`, error);
      throw error;
    }
  }

  async getBlockNumber(chainName: string): Promise<number> {
    const provider = this.getEvmProvider(chainName);
    if (!provider) throw new Error(`Provider not found for chain: ${chainName}`);

    try {
      return await provider.getBlockNumber();
    } catch (error) {
      console.error(`Failed to get block number for ${chainName}:`, error);
      throw error;
    }
  }

  isChainSupported(chainName: string): boolean {
    return this.evmProviders.has(chainName.toLowerCase());
  }

  getSupportedChains(): string[] {
    return Array.from(this.evmProviders.keys());
  }

  async healthCheck(): Promise<{ chain: string; status: string; latency?: number }[]> {
    const results: { chain: string; status: string; latency?: number }[] = [];

    for (const [chainName, provider] of this.evmProviders) {
      try {
        const start = Date.now();
        await provider.getBlockNumber();
        const latency = Date.now() - start;
        results.push({ chain: chainName, status: 'healthy', latency });
      } catch (error) {
        results.push({ chain: chainName, status: 'unhealthy' });
        console.error(`Health check failed for ${chainName}:`, error);
      }
    }

    return results;
  }
}

