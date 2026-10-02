/**
 * Approval Manager
 *
 * Manages ERC20 token approvals for DEX trading.
 * Handles checking allowances, requesting bounded approvals,
 * revoking stale approvals, and tracking approval history.
 */

import {
  type Address,
  type Hex,
  type Chain,
  getContract,
  parseUnits,
  maxUint256,
} from 'viem';
import { SupportedChainId, type ApprovalInfo, type ApprovalResult } from './types';
import type { WalletManager } from './wallet-manager';

// Viem chain import for type casting
import { mainnet, polygon, bsc, arbitrum, base, optimism } from 'viem/chains';

// Chain mapping for writeContract
const VIEM_APPROVAL_CHAINS: Record<SupportedChainId, Chain> = {
  [SupportedChainId.ETHEREUM]: mainnet as Chain,
  [SupportedChainId.POLYGON]: polygon as Chain,
  [SupportedChainId.BSC]: bsc as Chain,
  [SupportedChainId.ARBITRUM]: arbitrum as Chain,
  [SupportedChainId.BASE]: base as Chain,
  [SupportedChainId.OPTIMISM]: optimism as Chain,
};

// ---------------------------------------------------------------------------
// ERC20 ABI (approval-related)
// ---------------------------------------------------------------------------

const ERC20_ABI = [
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
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// ---------------------------------------------------------------------------
// Approval Record
// ---------------------------------------------------------------------------

interface ApprovalRecord {
  token: Address;
  spender: Address;
  amount: string;
  chainId: SupportedChainId;
  txHash: Hex;
  timestamp: Date;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Approval Manager
// ---------------------------------------------------------------------------

export class ApprovalManager {
  private approvalHistory: ApprovalRecord[] = [];
  private walletManager: WalletManager;

  constructor(walletManager: WalletManager) {
    this.walletManager = walletManager;
  }

  /**
   * Check the current allowance for a token spender pair.
   */
  async checkAllowance(
    chainId: SupportedChainId,
    token: Address,
    spender: Address,
  ): Promise<ApprovalInfo> {
    const publicClient = this.walletManager.getPublicClientForChain(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    const owner = this.walletManager.getAddress();

    const contract = getContract({
      address: token,
      abi: ERC20_ABI,
      client: publicClient,
    });

    const allowance = await contract.read.allowance([owner, spender]);

    return {
      token,
      spender,
      allowance: allowance.toString(),
      chainId,
    };
  }

  /**
   * Check if an approval is sufficient for the given amount.
   */
  async isApprovalSufficient(
    chainId: SupportedChainId,
    token: Address,
    spender: Address,
    amount: string,
  ): Promise<boolean> {
    const publicClient = this.walletManager.getPublicClientForChain(chainId);
    if (!publicClient) {
      throw new Error(`No public client for chain ${chainId}`);
    }

    const contract = getContract({
      address: token,
      abi: ERC20_ABI,
      client: publicClient,
    });

    const [allowance, decimals] = await Promise.all([
      contract.read.allowance([this.walletManager.getAddress(), spender]),
      contract.read.decimals(),
    ]);

    const requiredAmount = parseUnits(amount, decimals);
    return allowance >= requiredAmount;
  }

  /**
   * Request a bounded token approval (not unlimited).
   * Creates a bounded approval amount = requested amount * 1.1 for safety margin.
   */
  async requestApproval(
    chainId: SupportedChainId,
    token: Address,
    spender: Address,
    amount: string,
  ): Promise<ApprovalResult> {
    const walletClient = this.walletManager.getWalletClient(chainId);
    const publicClient = this.walletManager.getPublicClientForChain(chainId);
    if (!walletClient || !publicClient) {
      throw new Error(`No wallet/public client for chain ${chainId}`);
    }

    const contract = getContract({
      address: token,
      abi: ERC20_ABI,
      client: { public: publicClient, wallet: walletClient },
    });

    const decimals = await contract.read.decimals();
    const requiredAmount = parseUnits(amount, decimals);

    // Add 10% buffer for safety, but cap at maxUint256
    const approvalAmount = requiredAmount + (requiredAmount / 10n);

    const { request } = await contract.simulate.approve([spender, approvalAmount]);
    const txHash = await walletClient.writeContract({
      ...request,
      chain: VIEM_APPROVAL_CHAINS[chainId],
      account: this.walletManager.getAccount(),
    });

    // Track in history
    this.approvalHistory.push({
      token,
      spender,
      amount: approvalAmount.toString(),
      chainId,
      txHash,
      timestamp: new Date(),
      revoked: false,
    });

    // Wait for confirmation
    await this.walletManager.waitForTransaction(chainId, txHash);

    return {
      txHash,
      chainId,
      token,
      spender,
      amount: approvalAmount.toString(),
    };
  }

  /**
   * Revoke an approval by setting allowance to 0.
   */
  async revokeApproval(
    chainId: SupportedChainId,
    token: Address,
    spender: Address,
  ): Promise<ApprovalResult> {
    const walletClient = this.walletManager.getWalletClient(chainId);
    const publicClient = this.walletManager.getPublicClientForChain(chainId);
    if (!walletClient || !publicClient) {
      throw new Error(`No wallet/public client for chain ${chainId}`);
    }

    const contract = getContract({
      address: token,
      abi: ERC20_ABI,
      client: { public: publicClient, wallet: walletClient },
    });

    const { request } = await contract.simulate.approve([spender, 0n]);
    const txHash = await walletClient.writeContract({
      ...request,
      chain: VIEM_APPROVAL_CHAINS[chainId],
      account: this.walletManager.getAccount(),
    });

    // Track in history
    this.approvalHistory.push({
      token,
      spender,
      amount: '0',
      chainId,
      txHash,
      timestamp: new Date(),
      revoked: true,
    });

    // Wait for confirmation
    await this.walletManager.waitForTransaction(chainId, txHash);

    return {
      txHash,
      chainId,
      token,
      spender,
      amount: '0',
    };
  }

  /**
   * Revoke all tracked approvals for a specific token on a chain.
   */
  async revokeAllForToken(
    chainId: SupportedChainId,
    token: Address,
  ): Promise<ApprovalResult[]> {
    const results: ApprovalResult[] = [];
    const trackedSpenders = this.approvalHistory
      .filter(
        (r) =>
          r.chainId === chainId &&
          r.token.toLowerCase() === token.toLowerCase() &&
          !r.revoked,
      )
      .map((r) => r.spender);

    const uniqueSpenders = [...new Set(trackedSpenders)];

    for (const spender of uniqueSpenders) {
      const result = await this.revokeApproval(chainId, token, spender);
      results.push(result);
    }

    return results;
  }

  /**
   * Get approval history for a chain or specific token.
   */
  getApprovalHistory(
    chainId?: SupportedChainId,
    token?: Address,
  ): ApprovalRecord[] {
    return this.approvalHistory.filter((record) => {
      if (chainId !== undefined && record.chainId !== chainId) return false;
      if (token !== undefined && record.token.toLowerCase() !== token.toLowerCase()) return false;
      return true;
    });
  }

  /**
   * Get all active (non-revoked) approvals for a chain.
   */
  getActiveApprovals(chainId: SupportedChainId): ApprovalRecord[] {
    return this.approvalHistory.filter(
      (r) => r.chainId === chainId && !r.revoked,
    );
  }
}
