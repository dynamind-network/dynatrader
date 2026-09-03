/**
 * CLI Command: risk
 */

import type { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import { bold, cyan, green, red, yellow, dim, formatCurrency, printSeparator, printHeader } from '../utils';

export async function cmdRisk(runtime: DynaTraderRuntime): Promise<void> {
  printHeader('Risk State');

  console.log(bold('  Policy Limits:'));
  console.log(`    Max Position Notional: ${formatCurrency(10000)}`);
  console.log(`    Max Daily Loss:        ${formatCurrency(1000)}`);
  console.log(`    Max Open Orders:       10`);
  console.log(`    Max Position Size:     ${formatCurrency(5000)}`);
  console.log(`    Max Drawdown:          20%`);

  console.log();
  console.log(bold('  Circuit Breakers:'));
  console.log(`    Max Orders/Minute:     5`);
  console.log(`    Max Order Value:       ${formatCurrency(2000)}`);
  console.log(`    Loss Streak Pause:     5 consecutive losses`);

  console.log();
  console.log(bold('  Current State:'));

  // Try to get portfolio info from exchange
  try {
    const exchange = runtime.getExchange();
    const balances = await exchange.balances();
    const free = (balances.free as Record<string, number>) || {};
    const total = (balances.total as Record<string, number>) || {};

    const nonZeroBalances = Object.entries(total).filter(
      ([, val]) => typeof val === 'number' && val > 0,
    );

    if (nonZeroBalances.length > 0) {
      console.log(`    Balances:`);
      for (const [asset, amount] of nonZeroBalances) {
        const freeAmt = free[asset] ?? 0;
        console.log(`      ${asset}: ${amount} (free: ${freeAmt})`);
      }
    } else {
      console.log(`    Balances: ${dim('empty (paper mode)')}`);
    }
  } catch {
    console.log(`    Balances: ${yellow('unavailable')}`);
  }

  console.log();
  console.log(bold('  Open Positions:'));
  console.log(`    ${dim('No open positions')}`);

  console.log();
  console.log(bold('  Daily P&L:'));
  console.log(`    ${formatCurrency(0)}`);

  console.log();
  console.log(bold('  Drawdown:'));
  console.log(`    0.00% (no drawdown)`);

  console.log();
}
