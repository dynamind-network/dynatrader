/**
 * Wallet Manager Tests
 *
 * Unit tests for the WalletManager class with mocked viem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock viem modules
vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({
    sendTransaction: vi.fn().mockResolvedValue('0x1234567890abcdef'),
    writeContract: vi.fn().mockResolvedValue('0xabcdef1234567890'),
  })),
  createPublicClient: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      blockNumber: 12345n,
      gasUsed: 21000n,
      effectiveGasPrice: 20000000000n,
      logs: [],
    }),
    getBlockNumber: vi.fn().mockResolvedValue(12345n),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000n }),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
  })),
  http: vi.fn(() => ({})),
  formatEther: vi.fn((val: bigint) => (Number(val) / 1e18).toString()),
  formatUnits: vi.fn((val: bigint, decimals: number) => (Number(val) / 10 ** decimals).toString()),
  parseUnits: vi.fn((val: string, decimals: number) => BigInt(Math.round(parseFloat(val) * 10 ** decimals))),
  getContract: vi.fn(() => ({
    read: {
      balanceOf: vi.fn().mockResolvedValue(1000000n),
      decimals: vi.fn().mockResolvedValue(6),
      symbol: vi.fn().mockResolvedValue('USDC'),
      name: vi.fn().mockResolvedValue('USD Coin'),
      allowance: vi.fn().mockResolvedValue(1000000n),
    },
    simulate: {
      approve: vi.fn().mockResolvedValue({ request: {} }),
      transfer: vi.fn().mockResolvedValue({ request: {} }),
    },
  })),
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicKey: '0x04...',
  })),
}));

vi.mock('viem/chains', () => ({
  mainnet: { id: 1, name: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  polygon: { id: 137, name: 'Polygon', nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 } },
  bsc: { id: 56, name: 'BSC', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } },
  arbitrum: { id: 42161, name: 'Arbitrum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  base: { id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  optimism: { id: 10, name: 'Optimism', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
}));

// Mock the chain registry
vi.mock('../../wallet/chain-registry', () => ({
  getChainConfig: vi.fn((chainId: number) => ({
    chainId,
    name: `Chain ${chainId}`,
    rpcUrl: `https://rpc.chain${chainId}.com`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrl: `https://explorer.chain${chainId}.com`,
    blockExplorerApiUrl: `https://api.explorer.chain${chainId}.com`,
    contracts: {},
  })),
  getPublicClient: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
  })),
  formatNativeBalance: vi.fn(() => '1.0000'),
}));

// Mock encryption service
vi.mock('../../monitoring/security/encryption', () => ({
  EncryptionService: vi.fn().mockImplementation(() => ({
    encrypt: vi.fn((data: string) => ({
      encrypted: 'encrypted_' + data,
      iv: 'iv',
      tag: 'tag',
      algorithm: 'aes-256-gcm',
      version: 1,
    })),
    decrypt: vi.fn((data: { encrypted: string }) => data.encrypted.replace('encrypted_', '')),
  })),
}));

import { WalletManager } from '../../wallet/wallet-manager';
import { SupportedChainId } from '../../wallet/types';

describe('WalletManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env['WALLET_PRIVATE_KEY'] = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should create a WalletManager with config', () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });
      expect(manager).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize successfully with valid private key', async () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await manager.initialize();

      expect(manager.getAddress()).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should throw when private key env var is missing', async () => {
      delete process.env['WALLET_PRIVATE_KEY'];

      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await expect(manager.initialize()).rejects.toThrow('Private key not found');
    });

    it('should throw on invalid private key format', async () => {
      process.env['WALLET_PRIVATE_KEY'] = 'invalid-key';

      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await expect(manager.initialize()).rejects.toThrow('Invalid private key format');
    });
  });

  describe('getAddress', () => {
    it('should throw before initialization', () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      expect(() => manager.getAddress()).toThrow('Wallet not initialized');
    });

    it('should return address after initialization', async () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await manager.initialize();

      expect(manager.getAddress()).toBe('0x1234567890123456789012345678901234567890');
    });
  });

  describe('getWalletInfo', () => {
    it('should return info for all configured chains', async () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM, SupportedChainId.POLYGON],
      });

      await manager.initialize();

      const info = manager.getWalletInfo();
      expect(info).toHaveLength(2);
      expect(info[0]?.chainId).toBe(SupportedChainId.ETHEREUM);
      expect(info[1]?.chainId).toBe(SupportedChainId.POLYGON);
    });
  });

  describe('getNativeBalance', () => {
    it('should return formatted balance', async () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await manager.initialize();

      const balance = await manager.getNativeBalance(SupportedChainId.ETHEREUM);
      expect(balance).toBe('1.0000');
    });
  });

  describe('getEncryptedKeyData', () => {
    it('should return null before initialization', () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      expect(manager.getEncryptedKeyData()).toBeNull();
    });

    it('should return encrypted data after initialization', async () => {
      const manager = new WalletManager({
        privateKeyEnvVar: 'WALLET_PRIVATE_KEY',
        chains: [SupportedChainId.ETHEREUM],
      });

      await manager.initialize();

      const encrypted = manager.getEncryptedKeyData();
      expect(encrypted).not.toBeNull();
      expect(typeof encrypted).toBe('string');
    });
  });
});
