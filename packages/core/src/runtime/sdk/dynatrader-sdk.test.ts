import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '@dyna/contracts';
import { createDynaSdkInvoker, createDynaTraderSdk, DYNA_SDK_METHODS } from './dynatrader-sdk';

describe('DynaTrader SDK bridge', () => {
  it('routes general agent capabilities and order methods through the injected host executor', async () => {
    const execute = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      success: true, data: { tool: call.tool, args: call.args }, durationMs: 1, truncated: false,
    }));
    const invoker = createDynaSdkInvoker(execute);
    const sdk = createDynaTraderSdk(invoker, { sessionId: 'conversation-1' });

    await expect(sdk.trading.proposeOrder({ symbol: 'BTC/USD' })).resolves.toMatchObject({ tool: 'propose_order' });
    await expect(sdk.trading.executeOrder({ proposalId: 'proposal-1' })).resolves.toMatchObject({ tool: 'execute_order' });
    await expect(sdk.memory.search({ scope: 'session', text: 'prior trade' })).resolves.toMatchObject({ tool: 'memory_search' });
    await expect(sdk.skills.list()).resolves.toMatchObject({ tool: 'skills_list' });
    await expect(sdk.agents.delegate({ task: 'review data' })).resolves.toMatchObject({ tool: 'delegate_task' });

    expect(execute.mock.calls.map(([call]) => call.tool)).toEqual([
      'propose_order', 'execute_order', 'memory_search', 'skills_list', 'delegate_task',
    ]);
    expect(DYNA_SDK_METHODS).toContain('trading.executeOrder');
    expect(DYNA_SDK_METHODS).toContain('memory.write');
  });

  it('surfaces host authorization failures to the REPL caller', async () => {
    const invoker = createDynaSdkInvoker(async () => ({
      success: false, error: 'Trading profile is not enabled.', durationMs: 0, truncated: false,
    }));
    const sdk = createDynaTraderSdk(invoker, { sessionId: 'conversation-2' });

    await expect(sdk.trading.executeOrder({ proposalId: 'proposal-1' })).rejects.toThrow('Trading profile is not enabled');
  });
});
