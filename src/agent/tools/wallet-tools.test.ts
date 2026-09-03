import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletSwapTool } from './wallet-tools';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { StateDb } from '../../state-db/state-db';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockWalletManager = {
  getAddress: vi.fn().mockReturnValue('0xmock'),
  getBalances: vi.fn().mockResolvedValue([]),
  getTokenBalance: vi.fn().mockResolvedValue({ balance: '0', decimals: 18 }),
  getTransactionHistory: vi.fn().mockResolvedValue([]),
};

const mockPipeline = {
  executeSwap: vi.fn(),
};

const mockAdapter = {
  getQuote: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDbDir(): string {
  const dir = join(tmpdir(), `wallet-test-${randomUUID()}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cleanDbDir(dir: string): void {
  for (const file of ['state.db', 'state.db-wal', 'state.db-shm']) {
    try {
      const p = join(dir, file);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }
  try {
    if (existsSync(dir)) unlinkSync(dir);
  } catch {
    // ignore (dir may not be empty)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletSwapTool StateDb integration', () => {
  let dbDir: string;

  beforeEach(() => {
    dbDir = getDbDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanDbDir(dbDir);
  });

  it('should record trade in StateDb after successful swap', async () => {
    const db = new StateDb(dbDir);
    const adapters = new Map([['0x', mockAdapter as any]]);

    mockPipeline.executeSwap.mockResolvedValueOnce({
      success: true,
      txHash: '0xabc123',
      chainId: 1,
      stages: [{ stage: 'swap', success: true, durationMs: 100 }],
    });

    const tool = new WalletSwapTool(
      mockWalletManager as any,
      mockPipeline as any,
      adapters,
      db,
    );
    const result = await tool.execute({
      args: {
        chainId: 1,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: '100',
      },
      sessionId: 'sess-test',
    } as any);

    expect(result.success).toBe(true);

    // Verify trade was persisted
    const trades = db.listTrades({ sessionId: 'sess-test' });
    expect(trades.length).toBe(1);
    expect(trades[0]!.symbol).toBe('0xTokenA/0xTokenB');
    expect(trades[0]!.status).toBe('open');

    db.close();
  });

  it('should not fail when StateDb is not provided', async () => {
    const adapters = new Map([['0x', mockAdapter as any]]);
    mockPipeline.executeSwap.mockResolvedValueOnce({
      success: true,
      txHash: '0xdef456',
      chainId: 1,
      stages: [{ stage: 'swap', success: true, durationMs: 100 }],
    });

    const tool = new WalletSwapTool(
      mockWalletManager as any,
      mockPipeline as any,
      adapters,
    );
    const result = await tool.execute({
      args: {
        chainId: 1,
        tokenIn: '0xTokenA',
        tokenOut: '0xTokenB',
        amountIn: '100',
      },
    } as any);

    expect(result.success).toBe(true);
  });
});
