import type { DynaTraderRuntime } from '@dyna/core/cli';
import { bold, cyan, dim, green, red } from '../utils';

export async function cmdPortfolio(runtime: DynaTraderRuntime): Promise<void> {
  console.log();
  console.log(bold(cyan('Portfolio')));
  try {
    const balance = await runtime.getExchange().balances();
    console.log(`  Equity: ${String(balance.equity ?? 'unavailable')}`);
    console.log(`  Free:   ${String(balance.free ?? 'unavailable')}`);
    console.log(`  Used:   ${String(balance.used ?? 'unavailable')}`);
  } catch (error) {
    console.log(red(`  Account data unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }

  const trades = runtime.getTradeHistory({ limit: 10 });
  console.log();
  console.log(bold('Recent trades'));
  if (trades.length === 0) {
    console.log(dim('  No persisted trades.'));
    return;
  }
  for (const trade of trades) {
    const color = trade.status === 'open' ? green : dim;
    console.log(`  ${color(trade.status.toUpperCase())} ${trade.symbol} ${trade.quantity} @ ${trade.entry_price} (${trade.dex})`);
  }
}
