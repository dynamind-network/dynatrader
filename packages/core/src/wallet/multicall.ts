/**
 * Multicall Batch Reader
 *
 * Gas-efficient batch balance + allowance queries via Multicall3 contract.
 * Uses the canonical Multicall3 address (0xcA11bde05977b3631167028862bE2a173976CA11)
 * which is the same across all supported chains.
 */

import {
  type Address,
  type Hex,
  encodeFunctionData,
  decodeAbiParameters,
} from 'viem';
import { SupportedChainId } from './types';
import { getPublicClient, getChainConfig } from './chain-registry';

// ---------------------------------------------------------------------------
// Multicall3 Address (canonical, same on all chains)
// ---------------------------------------------------------------------------

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MulticallBalanceResult {
  token: Address;
  balance: bigint;
  allowance: bigint;
}

export interface BatchBalanceQuery {
  token: Address;
  spender?: Address; // If provided, also queries allowance
}

// ---------------------------------------------------------------------------
// Batch Balance Reader
// ---------------------------------------------------------------------------

export class BatchBalanceReader {
  /**
   * Query balances for multiple tokens in a single RPC call.
   */
  async getBalances(
    chainId: SupportedChainId,
    tokens: Address[],
    owner: Address,
  ): Promise<Map<Address, bigint>> {
    const client = getPublicClient(chainId);
    const config = getChainConfig(chainId);

    if (!config.contracts.multicall3) {
      return this.fallbackBalances(client, tokens, owner);
    }

    const multicallAddress = config.contracts.multicall3 ?? MULTICALL3_ADDRESS;

    const calls = tokens.map((token) => ({
      target: token,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner],
      }),
    }));

    try {
      const result = await client.readContract({
        address: multicallAddress,
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        args: [calls as any],
      });

      const balances = new Map<Address, bigint>();
      for (let i = 0; i < tokens.length; i++) {
        const callResult = (result as any)[i];
        if (callResult?.success && callResult?.returnData && callResult.returnData !== '0x') {
          const [balance] = decodeAbiParameters(
            [{ type: 'uint256' }],
            callResult.returnData,
          );
          balances.set(tokens[i]!, balance as bigint);
        } else {
          balances.set(tokens[i]!, 0n);
        }
      }
      return balances;
    } catch {
      return this.fallbackBalances(client, tokens, owner);
    }
  }

  /**
   * Query balances AND allowances in a single multicall.
   * Critical for gas-efficient approval checks before swaps.
   */
  async getBalancesAndAllowances(
    chainId: SupportedChainId,
    queries: BatchBalanceQuery[],
    owner: Address,
  ): Promise<MulticallBalanceResult[]> {
    const client = getPublicClient(chainId);
    const config = getChainConfig(chainId);

    if (!config.contracts.multicall3) {
      return this.fallbackBalancesAndAllowances(client, queries, owner);
    }

    const multicallAddress = config.contracts.multicall3 ?? MULTICALL3_ADDRESS;

    // Build calls: balanceOf for each token + allowance for tokens with spender
    const calls: Array<{
      target: Address;
      allowFailure: boolean;
      callData: Hex;
    }> = [];

    for (const query of queries) {
      calls.push({
        target: query.token,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [owner],
        }),
      });
      if (query.spender) {
        calls.push({
          target: query.token,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [owner, query.spender],
          }),
        });
      }
    }

    try {
      const result = await client.readContract({
        address: multicallAddress,
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        args: [calls as any],
      });

      const results: MulticallBalanceResult[] = [];
      let callIdx = 0;

      for (const query of queries) {
        const balanceCall = (result as any)[callIdx]!;
        callIdx++;

        let balance = 0n;
        if (balanceCall?.success && balanceCall?.returnData && balanceCall.returnData !== '0x') {
          const [decoded] = decodeAbiParameters(
            [{ type: 'uint256' }],
            balanceCall.returnData,
          );
          balance = decoded as bigint;
        }

        let allowance = 0n;
        if (query.spender) {
          const allowanceCall = (result as any)[callIdx]!;
          callIdx++;
          if (allowanceCall?.success && allowanceCall?.returnData && allowanceCall.returnData !== '0x') {
            const [decoded] = decodeAbiParameters(
              [{ type: 'uint256' }],
              allowanceCall.returnData,
            );
            allowance = decoded as bigint;
          }
        }

        results.push({ token: query.token, balance, allowance });
      }

      return results;
    } catch {
      return this.fallbackBalancesAndAllowances(client, queries, owner);
    }
  }

  // ---------------------------------------------------------------------------
  // Fallback (sequential individual calls)
  // ---------------------------------------------------------------------------

  private async fallbackBalances(
    client: ReturnType<typeof getPublicClient>,
    tokens: Address[],
    owner: Address,
  ): Promise<Map<Address, bigint>> {
    const balances = new Map<Address, bigint>();
    for (const token of tokens) {
      try {
        const balance = await client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [owner],
        });
        balances.set(token, balance);
      } catch {
        balances.set(token, 0n);
      }
    }
    return balances;
  }

  private async fallbackBalancesAndAllowances(
    client: ReturnType<typeof getPublicClient>,
    queries: BatchBalanceQuery[],
    owner: Address,
  ): Promise<MulticallBalanceResult[]> {
    const results: MulticallBalanceResult[] = [];
    for (const query of queries) {
      let balance = 0n;
      let allowance = 0n;
      try {
        balance = await client.readContract({
          address: query.token,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [owner],
        });
      } catch { /* ignore */ }
      if (query.spender) {
        try {
          allowance = await client.readContract({
            address: query.token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [owner, query.spender],
          });
        } catch { /* ignore */ }
      }
      results.push({ token: query.token, balance, allowance });
    }
    return results;
  }
}
