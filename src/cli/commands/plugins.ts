import type { DynaTraderRuntime } from '@dyna/orchestration/workspace';
import { bold, cyan, dim, green, red, yellow } from '../utils';

/** Operator commands for the live declarative plugin tree. */
export async function cmdPlugins(
  runtime: DynaTraderRuntime,
  subcommand: string,
  args: string[],
): Promise<void> {
  const registry = runtime.getPluginRegistry();
  const action = subcommand.toLowerCase();

  if (action === 'list') {
    const stats = registry.getStats();
    console.log(bold(cyan('Plugins')));
    for (const entry of registry.listPlugins()) {
      const state = entry.status === 'active' ? green(entry.status) : entry.status === 'error' ? red(entry.status) : yellow(entry.status);
      console.log(`  ${entry.plugin.id} v${entry.plugin.version}  ${state}  [${entry.plugin.capabilities.join(', ')}]`);
      if (entry.error) console.log(`    ${red(entry.error)}`);
    }
    console.log(dim(`\n${stats.activePlugins}/${stats.totalPlugins} active`));
    return;
  }

  if (action === 'info') {
    const id = args[0];
    const entry = registry.listPlugins().find((plugin) => plugin.plugin.id === id);
    if (!entry) throw new Error(`Plugin not found: ${id ?? '(missing id)'}`);
    console.log(JSON.stringify({
      id: entry.plugin.id,
      version: entry.plugin.version,
      description: entry.plugin.description,
      status: entry.status,
      capabilities: entry.plugin.capabilities,
      config: registry.getPluginConfig(entry.plugin.id),
    }, null, 2));
    return;
  }

  if (action === 'reload') {
    const id = args[0];
    if (!id) throw new Error('Usage: dynatrader plugins reload <id>');
    await registry.reload(id);
    console.log(green(`Reloaded plugin: ${id}`));
    return;
  }

  if (action === 'config') {
    const tree = registry.listPlugins().map((entry) => ({
      id: entry.plugin.id,
      entry: entry.plugin.id,
      enabled: entry.status !== 'error',
      status: entry.status,
      capabilities: entry.plugin.capabilities,
      config: registry.getPluginConfig(entry.plugin.id),
    }));
    console.log(JSON.stringify({ plugins: tree, capabilities: registry.getStats().capabilities }, null, 2));
    return;
  }

  throw new Error(`Unknown plugins subcommand: ${subcommand}. Use list, info, reload, or config.`);
}
