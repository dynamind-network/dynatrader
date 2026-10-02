/**
 * CLI Runtime Initialization
 *
 * Creates and starts a DynaTraderRuntime instance for CLI commands.
 */

import { DynaTraderRuntime } from '@dyna/core/cli';
import type { RuntimeConfig } from '@dyna/core/cli';
import { getStatePath } from '@dyna/core/cli';

export async function initRuntime(
  workspacePath: string,
  mode: 'research' | 'paper' | 'backtest' | 'live',
): Promise<DynaTraderRuntime> {
  const config: RuntimeConfig = {
    workspacePath,
    statePath: getStatePath(),
    mode,
    strictMode: false,
    requireRiskProfile: false,
    requireTradingPolicy: false,
    requireAuthConfig: false,
    liveTradingEnabled: false,
    enableShadowMode: false,
    enableMicroLiveMode: false,
  };

  const runtime = new DynaTraderRuntime(workspacePath, config);
  await runtime.start();
  return runtime;
}
