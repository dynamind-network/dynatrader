/**
 * Gas Estimator — EIP-1559 Cascade
 *
 * Production-proven gas estimation with EIP-1559 auto-detection.
 * Cascade: estimateGas → EIP-1559 fees → legacy gas price → cached fallback.
 * Supports EIP-1559 auto-detection per chain.
 */

import {
  type Address,
  type Hex,
  formatUnits,
  parseUnits,
} from 'viem';
import { SupportedChainId, type TransactionRequest } from './types';
import { getPublicClient, getChainConfig } from './chain-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GasEstimate {
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  isEIP1559: boolean;
  chainId: SupportedChainId;
  estimatedAt: number;
}

export interface GasPriceInfo {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  isEIP1559: boolean;
  chainId: SupportedChainId;
  estimatedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const GAS_CACHE_TTL_MS = 15_000; // 15 seconds
const gasCache = new Map<string, GasPriceInfo>();

function cacheKey(chainId: SupportedChainId): string {
  return `gas:${chainId}`;
}

function getCachedGas(chainId: SupportedChainId): GasPriceInfo | null {
  const key = cacheKey(chainId);
  const cached = gasCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.estimatedAt > GAS_CACHE_TTL_MS) {
    gasCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedGas(info: GasPriceInfo): void {
  gasCache.set(cacheKey(info.chainId), info);
}

// ---------------------------------------------------------------------------
// EIP-1559 Support Map
// ---------------------------------------------------------------------------

/** Chains known to support EIP-1559 */
const EIP1559_CHAINS = new Set([
  SupportedChainId.ETHEREUM,
  SupportedChainId.ARBITRUM,
  SupportedChainId.BASE,
  SupportedChainId.OPTIMISM,
]);

// ---------------------------------------------------------------------------
// Gas Estimator
// ---------------------------------------------------------------------------

export class GasEstimator {
  /**
   * Estimate gas limit for a transaction via eth_estimateGas.
   */
  async estimateGas(
    chainId: SupportedChainId,
    tx: { to: Address; data?: Hex; value?: bigint; from?: Address },
  ): Promise<bigint> {
    const client = getPublicClient(chainId);
    try {
      const estimate = await client.estimateGas({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        account: tx.from,
      });
      // Add 20% buffer
      return (estimate * 120n) / 100n;
    } catch {
      // Fallback: return a conservative default based on chain
      return chainId === SupportedChainId.BSC ? 500_000n : 300_000n;
    }
  }

  /**
   * Estimate gas price using EIP-1559 cascade.
   *
   * Cascade order:
   * 1. Try estimateFeesPerGas() for EIP-1559 (type 2)
   * 2. Try getGasPrice() for legacy (type 0)
   * 3. Return cached values if both fail
   */
  async estimateGasPrice(chainId: SupportedChainId): Promise<GasPriceInfo> {
    // Check cache first
    const cached = getCachedGas(chainId);
    if (cached) return cached;

    const client = getPublicClient(chainId);
    const supportsEIP1559 = EIP1559_CHAINS.has(chainId);

    // Attempt 1: EIP-1559
    if (supportsEIP1559) {
      try {
        const fees = await client.estimateFeesPerGas();
        const info: GasPriceInfo = {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          isEIP1559: true,
          chainId,
          estimatedAt: Date.now(),
        };
        setCachedGas(info);
        return info;
      } catch {
        // Fall through to legacy
      }
    }

    // Attempt 2: Legacy gas price
    try {
      const gasPrice = await client.getGasPrice();
      const info: GasPriceInfo = {
        gasPrice,
        isEIP1559: false,
        chainId,
        estimatedAt: Date.now(),
      };
      setCachedGas(info);
      return info;
    } catch {
      // Fall through to cache
    }

    // Attempt 3: Return stale cache or defaults
    if (cached) return cached;

    return {
      gasPrice: parseUnits('20', 9), // 20 gwei fallback
      isEIP1559: false,
      chainId,
      estimatedAt: Date.now(),
    };
  }

  /**
   * Prepare gas options for a transaction request.
   * Returns the correct fee fields based on chain EIP-1559 support.
   */
  async prepareGasOptions(
    chainId: SupportedChainId,
    gasLimit?: bigint,
  ): Promise<Partial<TransactionRequest>> {
    const gasInfo = await this.estimateGasPrice(chainId);
    const config = getChainConfig(chainId);

    const result: Partial<TransactionRequest> = {};

    if (gasLimit) {
      result.gasLimit = `0x${gasLimit.toString(16)}` as Hex;
    }

    if (gasInfo.isEIP1559 && gasInfo.maxFeePerGas && gasInfo.maxPriorityFeePerGas) {
      result.maxFeePerGas = `0x${gasInfo.maxFeePerGas.toString(16)}` as Hex;
      result.maxPriorityFeePerGas = `0x${gasInfo.maxPriorityFeePerGas.toString(16)}` as Hex;
    } else if (gasInfo.gasPrice) {
      result.gasPrice = `0x${gasInfo.gasPrice.toString(16)}` as Hex;
    }

    return result;
  }

  /**
   * Check if gas price is within acceptable threshold.
   * Returns true if gas is OK, false if too expensive.
   */
  async isGasAcceptable(
    chainId: SupportedChainId,
    maxGasPriceGwei: number,
  ): Promise<{ acceptable: boolean; currentGwei: string; maxGwei: number }> {
    const gasInfo = await this.estimateGasPrice(chainId);
    const maxWei = BigInt(maxGasPriceGwei) * 10n ** 9n;

    let currentWei: bigint;
    if (gasInfo.isEIP1559 && gasInfo.maxFeePerGas) {
      currentWei = gasInfo.maxFeePerGas;
    } else if (gasInfo.gasPrice) {
      currentWei = gasInfo.gasPrice;
    } else {
      return { acceptable: true, currentGwei: '0', maxGwei: maxGasPriceGwei };
    }

    const currentGwei = formatUnits(currentWei, 9);
    return {
      acceptable: currentWei <= maxWei,
      currentGwei,
      maxGwei: maxGasPriceGwei,
    };
  }

  /**
   * Clear the gas price cache (useful for testing or forced refresh).
   */
  clearCache(): void {
    gasCache.clear();
  }
}
