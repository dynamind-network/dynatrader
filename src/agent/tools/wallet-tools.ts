/**
 * Wallet Agent Tools
 *
 * Five agent tools for wallet/DEX operations, following the ToolHandler
 * interface pattern established by cron-tools.ts.
 */

import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';
import type { Address } from 'viem';
import { randomUUID } from 'node:crypto';
import { SupportedChainId } from '../../wallet/types';
import type { WalletManager } from '../../wallet/wallet-manager';
import type { ApprovalManager } from '../../wallet/approval-manager';
import type { TxPipeline } from '../../wallet/tx-pipeline';
import type { DEXAdapter } from '../../wallet/dex-adapters/adapter.interface';
import type { SwapQuote } from '../../wallet/types';
import type { TradeRow } from '../../state-db/types';

// ---------------------------------------------------------------------------
// Wallet Balance Tool
// ---------------------------------------------------------------------------

export class WalletBalanceTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'wallet_balance',
    description: 'Get wallet balance across EVM chains (native currency and ERC20 tokens)',
    category: 'execution',
    inputSchema: {
      chainId: 'number?',
      tokenAddress: 'string?',
    },
    outputSchema: { balances: 'array', address: 'string' },
    permissionsRequired: ['tool.wallet_balance'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 15000,
  };

  constructor(private walletManager: WalletManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const chainId = (call.args.chainId as number | undefined) as SupportedChainId | undefined;
      const tokenAddress = call.args.tokenAddress as string | undefined;

      const address = this.walletManager.getAddress();

      if (chainId && tokenAddress) {
        // Get specific token balance
        const { balance, decimals } = await this.walletManager.getTokenBalance(
          chainId,
          tokenAddress as Address,
        );
        return {
          success: true,
          data: {
            address,
            chainId,
            tokenAddress,
            balance,
            decimals,
          },
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Get all balances
      const tokens = tokenAddress
        ? [{ chainId: chainId ?? SupportedChainId.ETHEREUM, address: tokenAddress as Address }]
        : undefined;

      const balances = await this.walletManager.getBalances(tokens);

      return {
        success: true,
        data: {
          address,
          balances: balances.map((b) => ({
            chainId: b.chainId,
            chainName: b.chainName,
            nativeBalance: b.nativeBalance,
            tokenBalances: b.tokenBalances.map((tb) => ({
              symbol: tb.token.symbol,
              balance: tb.balanceFormatted,
            })),
          })),
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet Swap Tool
// ---------------------------------------------------------------------------

export class WalletSwapTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'wallet_swap',
    description: 'Execute a token swap on a DEX via the transaction pipeline',
    category: 'execution',
    inputSchema: {
      chainId: 'number',
      tokenIn: 'string',
      tokenOut: 'string',
      amountIn: 'string',
      slippageTolerance: 'number?',
      deadlineMinutes: 'number?',
      dex: 'string?',
    },
    outputSchema: { txHash: 'string', status: 'string', amountOut: 'string?' },
    permissionsRequired: ['tool.wallet_swap'],
    sideEffects: ['token_swap_executed'],
    riskLevel: 'high',
    timeoutMs: 120000,
  };

  constructor(
    private walletManager: WalletManager,
    private pipeline: TxPipeline,
    private adapters: Map<string, DEXAdapter>,
    private db?: import('../../state-db/state-db').StateDb,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const chainId = call.args.chainId as number;
      const tokenIn = call.args.tokenIn as string;
      const tokenOut = call.args.tokenOut as string;
      const amountIn = call.args.amountIn as string;
      const slippageTolerance = (call.args.slippageTolerance as number | undefined) ?? 0.5;
      const deadlineMinutes = (call.args.deadlineMinutes as number | undefined) ?? 20;
      const dexName = (call.args.dex as string | undefined) ?? '0x';

      // Select adapter
      const adapter = this.adapters.get(dexName);
      if (!adapter) {
        return {
          success: false,
          error: `DEX adapter not found: ${dexName}. Available: ${Array.from(this.adapters.keys()).join(', ')}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Execute swap through pipeline
      const result = await this.pipeline.executeSwap(
        {
          chainId: chainId as SupportedChainId,
          tokenIn: tokenIn as Address,
          tokenOut: tokenOut as Address,
          amountIn,
          slippageTolerance,
          deadlineMinutes,
        },
        adapter,
      );

      // After successful swap, record trade to state.db
      if (result.success && this.db) {
        const tradeId = `trade-${randomUUID()}`;
        const now = Date.now();
        const trade: TradeRow = {
          id: tradeId,
          session_id: (call as ToolCall & { sessionId?: string }).sessionId ?? '',
          symbol: `${tokenIn}/${tokenOut}`,
          side: 'long',
          entry_price: 0,
          exit_price: null,
          quantity: parseFloat(amountIn),
          pnl: null,
          pnl_percent: null,
          status: 'open',
          chain_id: chainId,
          tx_hash: result.txHash ?? null,
          dex: dexName,
          metadata: JSON.stringify({ tokenIn, tokenOut, slippageTolerance, deadlineMinutes }),
          opened_at: now,
          closed_at: null,
        };
        try {
          this.db.saveTrade(trade);
        } catch (err) {
          // non-fatal: log but don't fail the swap
          console.error('Failed to persist trade to state.db:', err);
        }
      }

      return {
        success: result.success,
        data: {
          txHash: result.txHash,
          status: result.success ? 'confirmed' : 'failed',
          chainId: result.chainId,
          stages: result.stages.map((s) => ({
            stage: s.stage,
            success: s.success,
            durationMs: s.durationMs,
          })),
          error: result.error,
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet Approve Tool
// ---------------------------------------------------------------------------

export class WalletApproveTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'wallet_approve',
    description: 'Approve ERC20 token spending for a DEX or contract',
    category: 'execution',
    inputSchema: {
      chainId: 'number',
      tokenAddress: 'string',
      spenderAddress: 'string',
      amount: 'string',
    },
    outputSchema: { txHash: 'string', status: 'string' },
    permissionsRequired: ['tool.wallet_approve'],
    sideEffects: ['token_approval_set'],
    riskLevel: 'medium',
    timeoutMs: 60000,
  };

  constructor(private approvalManager: ApprovalManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const chainId = call.args.chainId as number;
      const tokenAddress = call.args.tokenAddress as string;
      const spenderAddress = call.args.spenderAddress as string;
      const amount = call.args.amount as string;

      const result = await this.approvalManager.requestApproval(
        chainId as SupportedChainId,
        tokenAddress as Address,
        spenderAddress as Address,
        amount,
      );

      return {
        success: true,
        data: {
          txHash: result.txHash,
          status: 'confirmed',
          token: result.token,
          spender: result.spender,
          amount: result.amount,
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet History Tool
// ---------------------------------------------------------------------------

export class WalletHistoryTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'wallet_history',
    description: 'Get recent transaction history for the wallet on a specific chain',
    category: 'execution',
    inputSchema: {
      chainId: 'number',
      limit: 'number?',
    },
    outputSchema: { transactions: 'array', count: 'number' },
    permissionsRequired: ['tool.wallet_history'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 60_000,
  };

  constructor(private walletManager: WalletManager) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const chainId = call.args.chainId as number;
      const limit = (call.args.limit as number | undefined) ?? 20;

      const history = await this.walletManager.getTransactionHistory(
        chainId as SupportedChainId,
        { limit },
      );

      return {
        success: true,
        data: {
          transactions: history.map((tx) => ({
            hash: tx.hash,
            blockNumber: tx.blockNumber.toString(),
            to: tx.to,
            gasUsed: tx.gasUsed.toString(),
            status: tx.status,
            timestamp: new Date(tx.timestamp * 1000).toISOString(),
          })),
          count: history.length,
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet Quote Tool
// ---------------------------------------------------------------------------

export class WalletQuoteTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'wallet_quote',
    description: 'Get a swap quote from a DEX without executing the trade',
    category: 'execution',
    inputSchema: {
      chainId: 'number',
      tokenIn: 'string',
      tokenOut: 'string',
      amountIn: 'string',
      slippageTolerance: 'number?',
      dex: 'string?',
    },
    outputSchema: { quote: 'object', source: 'string' },
    permissionsRequired: ['tool.wallet_quote'],
    sideEffects: [],
    riskLevel: 'low',
    timeoutMs: 60_000,
  };

  constructor(private adapters: Map<string, DEXAdapter>) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const chainId = call.args.chainId as number;
      const tokenIn = call.args.tokenIn as string;
      const tokenOut = call.args.tokenOut as string;
      const amountIn = call.args.amountIn as string;
      const slippageTolerance = (call.args.slippageTolerance as number | undefined) ?? 0.5;
      const dexName = (call.args.dex as string | undefined) ?? '0x';

      const adapter = this.adapters.get(dexName);
      if (!adapter) {
        return {
          success: false,
          error: `DEX adapter not found: ${dexName}. Available: ${Array.from(this.adapters.keys()).join(', ')}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const quote = await adapter.getQuote({
        chainId: chainId as SupportedChainId,
        tokenIn: tokenIn as Address,
        tokenOut: tokenOut as Address,
        amountIn,
        slippageTolerance,
      });

      return {
        success: true,
        data: {
          quote: {
            amountIn: quote.amountIn,
            amountOut: quote.amountOut,
            priceImpact: quote.priceImpact,
            source: quote.source,
            gasEstimate: quote.gasEstimate,
            route: {
              hops: quote.route.hops,
              pools: quote.route.pools.length,
            },
          },
          tokenIn: {
            symbol: quote.tokenIn.symbol,
            address: quote.tokenIn.address,
          },
          tokenOut: {
            symbol: quote.tokenOut.symbol,
            address: quote.tokenOut.address,
          },
        },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }
}
