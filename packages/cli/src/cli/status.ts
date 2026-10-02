/**
 * CLI Command: status
 */

import type { DynaTraderRuntime, RuntimeStatus, WorkspaceManifest } from '@dyna/core/cli';
import { bold, cyan, green, red, yellow, dim, formatDate, componentStatus, printSeparator } from './utils';

export async function cmdStatus(
  runtime: DynaTraderRuntime,
  workspace: WorkspaceManifest,
  options: { json?: boolean } = {},
): Promise<void> {
  const status: RuntimeStatus = runtime.getStatus();

  if (options.json) {
    let providers: string[] = [];
    let cost: unknown;
    if (status.components.modelRouter) {
      try {
        const costStats = await runtime.getModelRouter().getCostStats();
        providers = Object.keys(costStats.callsByProvider);
        cost = costStats;
      } catch {
        cost = null;
      }
    }
    let learnedSkills: number | null = null;
    try {
      learnedSkills = (await runtime.getSkillFactory().listSkills()).length;
    } catch {
      learnedSkills = null;
    }
    const exchange = status.components.exchange
      ? (() => { try { return runtime.getExchange().id; } catch { return null; } })()
      : null;
    console.log(JSON.stringify({
      version: '2.0.0',
      state: status.state,
      startedAt: status.startedAt?.toISOString() ?? null,
      mode: status.mode ?? 'research',
      workspacePath: status.workspacePath,
      components: status.components,
      providers,
      cost,
      exchange,
      workspace: {
        agents: workspace.agents.map((agent: any) => agent.name || 'unnamed'),
        skills: workspace.skills.map((skill: any) => skill.name || skill.manifest?.name || 'unnamed'),
        toolCount: workspace.tools.length,
        adapterCount: workspace.adapters.length,
        loopCount: workspace.loops.length,
        policies: workspace.policies.map((policy: any) => policy.name || 'unnamed'),
        learnedSkills,
      },
      contextCompaction: {
        autoCompactThreshold: 0.75,
        maxContextTokens: 80_000,
        toolPairProtection: true,
        preCompactionFlush: true,
      },
    }, null, 2));
    return;
  }

  console.log();
  console.log(bold(cyan('DynaTrader v2.0.0 - LLM Agent Harness')));
  printSeparator();

  const stateColor =
    status.state === 'running'
      ? green
      : status.state === 'error'
        ? red
        : yellow;
  console.log(`State: ${stateColor(status.state)}${status.startedAt ? ` (since ${formatDate(status.startedAt)})` : ''}`);
  console.log(`Mode: ${bold(status.mode ?? 'research')}`);
  console.log(`Workspace: ${status.workspacePath}`);

  // Components
  console.log();
  console.log(bold('Components:'));
  const components = status.components;
  console.log(`  ${componentStatus(components.memory)} Memory Store`);
  console.log(`  ${componentStatus(components.modelRouter)} Model Router`);
  console.log(`  ${componentStatus(components.toolRegistry)} Tool Registry`);
  console.log(`  ${componentStatus(components.agentCore)} Agent Core`);
  console.log(`  ${componentStatus(components.loopSync)} Loop Sync`);
  console.log(`  ${componentStatus(components.exchange)} Exchange`);
  console.log(`  ${componentStatus(components.eventBus)} Event Bus`);
  console.log(`  ${componentStatus(components.auditTrail)} Audit Trail`);

  // Model providers
  if (components.modelRouter) {
    try {
      const modelRouter = runtime.getModelRouter();
      const costStats = await modelRouter.getCostStats();
      const providerIds = Object.keys(costStats.callsByProvider);
      const providerNames = providerIds.length > 0
        ? providerIds.join(', ')
        : 'none registered';
      console.log(`    Providers: ${providerNames}`);
    } catch {
      console.log(`    Providers: ${yellow('unavailable')}`);
    }
  }

  // Exchange info
  if (components.exchange) {
    try {
      const exchange = runtime.getExchange();
      console.log(`    Exchange: ${exchange.id} (${status.mode === 'paper' || status.mode === 'backtest' ? 'test mode' : 'live mode'})`);
    } catch {
      console.log(`    Exchange: ${yellow('unavailable')}`);
    }
  }

  // Workspace summary
  console.log();
  console.log(bold('Workspace:'));
  console.log(
    `  Agents: ${workspace.agents.length}${
      workspace.agents.length > 0
        ? dim(` (${workspace.agents.map((a: any) => a.name || 'unnamed').join(', ')})`)
        : ''
    }`,
  );
  console.log(
    `  Skills: ${workspace.skills.length}${
      workspace.skills.length > 0
        ? dim(` (${workspace.skills.map((s: any) => s.name || s.manifest?.name || 'unnamed').join(', ')})`)
        : ''
    }`,
  );
  console.log(`  Tools: ${workspace.tools.length}`);
  console.log(`  Adapters: ${workspace.adapters.length}`);
  console.log(`  Loops: ${workspace.loops.length}`);
  console.log(
      `  Policies: ${workspace.policies.length}${
      workspace.policies.length > 0
        ? dim(` (${workspace.policies.map((p: any) => p.name || 'unnamed').join(', ')})`)
      : ''
    }`,
  );

  try {
    const skillFactory = runtime.getSkillFactory();
    const learnedSkills = await skillFactory.listSkills();
    console.log(`  Learned skills: ${learnedSkills.length}`);
  } catch {
    console.log(`  Learned skills: ${yellow('unavailable')}`);
  }

  // Context Compaction Status
  console.log();
  console.log(bold('Context Compaction'));
  console.log(`  Auto-Compact Threshold: ${bold('75%')} of context window`);
  console.log(`  Max Context Tokens: ${bold('80,000')}`);
  console.log(`  Tool Pair Protection: ${green('enabled')}`);
  console.log(`  Pre-Compaction Flush: ${green('enabled')}`);

  console.log();
}
