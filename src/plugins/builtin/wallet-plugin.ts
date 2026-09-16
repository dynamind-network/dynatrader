import type { DynaPlugin } from '../types';
import { WalletManager } from '../../wallet/wallet-manager';
import { ApprovalManager } from '../../wallet/approval-manager';
import { TxPipeline } from '../../wallet/tx-pipeline';
import { UniswapAdapter } from '../../wallet/dex-adapters/uniswap-adapter';
import { ZeroXAdapter } from '../../wallet/dex-adapters/zerox-adapter';
import { SupportedChainId } from '../../wallet/types';
import { WalletBalanceTool, WalletSwapTool, WalletApproveTool, WalletHistoryTool, WalletQuoteTool } from '../../agent/tools/wallet-tools';

export interface WalletPluginContainer {
  walletManager: WalletManager;
  approvalManager: ApprovalManager;
  txPipeline: TxPipeline;
  dexAdapters: Map<string, import('../../wallet/dex-adapters/adapter.interface').DEXAdapter>;
}

export function createWalletPlugin(config: Record<string, unknown>): DynaPlugin {
  const walletEnvVar = (config.privateKeyEnvVar as string | undefined) ?? 'WALLET_PRIVATE_KEY';
  const chains = (config.chains as SupportedChainId[] | undefined) ?? [SupportedChainId.ETHEREUM, SupportedChainId.POLYGON, SupportedChainId.ARBITRUM, SupportedChainId.BASE];
  const container: WalletPluginContainer = {
    walletManager: new WalletManager({ privateKeyEnvVar: walletEnvVar, chains }),
    approvalManager: undefined as never,
    txPipeline: undefined as never,
    dexAdapters: new Map(),
  };
  container.approvalManager = new ApprovalManager(container.walletManager);
  container.txPipeline = new TxPipeline(container.walletManager, container.approvalManager);
  container.dexAdapters.set('uniswap', new UniswapAdapter());
  container.dexAdapters.set('0x', new ZeroXAdapter());

  return {
    id: 'wallet',
    version: '1.0.0',
    description: 'Builtin wallet, transaction, approval, and DEX routing stack',
    capabilities: ['wallet', 'dex_routing', 'gas_estimation'],
    async init(ctx) {
      if (process.env[walletEnvVar]) await container.walletManager.initialize();
      ctx.registerService('wallet', container);
      ctx.registerService('dex_routing', container.dexAdapters);
      ctx.registerService('gas_estimation', container.txPipeline);
      ctx.registerTool({ name: 'wallet_balance', description: 'Read wallet balances', category: 'execution', inputSchema: {}, readOnly: true }, async () => new WalletBalanceTool(container.walletManager).execute({ tool: 'wallet_balance', args: {} }));
      ctx.registerTool({ name: 'wallet_swap', description: 'Execute a wallet swap', category: 'execution', inputSchema: { tokenIn: 'string', tokenOut: 'string', amount: 'string' }, permissionsRequired: ['wallet.swap'], riskLevel: 'high' }, async (call) => new WalletSwapTool(container.walletManager, container.txPipeline, container.dexAdapters).execute({ tool: 'wallet_swap', args: call.args }));
      ctx.registerTool({ name: 'wallet_approve', description: 'Approve a token spender', category: 'execution', inputSchema: { token: 'string', spender: 'string' }, permissionsRequired: ['wallet.approve'], riskLevel: 'high' }, async (call) => new WalletApproveTool(container.approvalManager).execute({ tool: 'wallet_approve', args: call.args }));
      ctx.registerTool({ name: 'wallet_history', description: 'Read wallet transaction history', category: 'execution', inputSchema: {}, readOnly: true }, async () => new WalletHistoryTool(container.walletManager).execute({ tool: 'wallet_history', args: {} }));
      ctx.registerTool({ name: 'wallet_quote', description: 'Quote a wallet swap', category: 'market', inputSchema: { tokenIn: 'string', tokenOut: 'string', amount: 'string' }, readOnly: true }, async (call) => new WalletQuoteTool(container.dexAdapters).execute({ tool: 'wallet_quote', args: call.args }));
    },
  };
}

export default createWalletPlugin;
