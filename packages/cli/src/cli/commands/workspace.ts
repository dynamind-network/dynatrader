/**
 * CLI Command: workspace
 */

import { WorkspaceManager } from '@dyna/core/cli';
import { bold, cyan, green, red, yellow, dim, formatDate, printSeparator } from '../utils';

export async function cmdWorkspace(
  workspacePath: string,
  sub: string,
  args: string[],
): Promise<void> {
  const manager = new WorkspaceManager(workspacePath);

  switch (sub) {
    case 'list': {
      console.log();
      console.log(bold(cyan('Workspaces')));
      printSeparator();

      const summaries = await manager.listWorkspaces();
      if (summaries.length === 0) {
        console.log(yellow('  No workspaces found.'));
        console.log();
        return;
      }

      for (const ws of summaries) {
        const statusColor = ws.status === 'active' ? green : yellow;
        console.log(`  ${bold(ws.name)} ${dim(`(${ws.id.slice(0, 8)}...)`)}`);
        console.log(`    Symbol: ${ws.symbol}`);
        console.log(`    Status: ${statusColor(ws.status)}`);
        console.log(`    Last:   ${formatDate(new Date(ws.lastActivity))}`);
      }
      console.log();
      break;
    }

    case 'create': {
      const name = args[0];
      if (!name) {
        console.log(red('Error: name is required.'));
        console.log(dim('Usage: dynatrader workspace create <name> [--symbol SYMBOL]'));
        return;
      }

      const ws = await manager.createWorkspace({
        name,
        description: `Workspace: ${name}`,
        symbol: '',
      });
      console.log(green(`Workspace created: ${ws.id}`));
      console.log(dim(`  Name:   ${ws.name}`));
      console.log(dim(`  Symbol: ${ws.symbol}`));
      console.log(dim(`  Status: ${ws.status}`));
      break;
    }

    case 'show': {
      const nameOrId = args[0];
      if (nameOrId) {
        let ws = await manager.getWorkspace(nameOrId);
        if (!ws) {
          const all = await manager.listWorkspaces();
          const found = all.find((s) => s.name === nameOrId);
          if (found) {
            ws = await manager.getWorkspace(found.id);
          }
        }

        if (!ws) {
          console.log(red(`Workspace not found: ${nameOrId}`));
          return;
        }

        console.log();
        console.log(bold(cyan('Workspace Details')));
        printSeparator();
        console.log(`  ID:          ${dim(ws.id)}`);
        console.log(`  Name:        ${bold(ws.name)}`);
        console.log(`  Symbol:      ${ws.symbol}`);
        console.log(`  Status:      ${ws.status}`);
        console.log(`  Description: ${ws.description}`);
        console.log(`  Thesis:      ${ws.thesis || dim('none')}`);
        console.log(`  Tags:        ${ws.tags.length > 0 ? ws.tags.join(', ') : dim('none')}`);
        console.log(`  Created:     ${formatDate(new Date(ws.createdAt))}`);
        console.log(`  Updated:     ${formatDate(new Date(ws.updatedAt))}`);
        console.log(`  Risk:`);
        console.log(`    Max Position: ${ws.riskParameters.maxPositionSize * 100}%`);
        console.log(`    Max Drawdown: ${(ws.riskParameters.maxDrawdown * 100).toFixed(1)}%`);
        console.log(`    Stop Loss:    ${(ws.riskParameters.stopLoss * 100).toFixed(1)}%`);
        console.log();
      } else {
        console.log();
        console.log(bold(cyan('Current Workspace')));
        printSeparator();
        console.log(`  Path: ${workspacePath}`);
        console.log();
      }
      break;
    }

    case 'validate': {
      try {
        await manager.listWorkspaces();
        console.log(green('Workspace structure is valid.'));
      } catch (err) {
        console.log(red(`Workspace validation failed: ${(err as Error).message}`));
      }
      break;
    }

    default: {
      console.log(red(`Unknown workspace subcommand: ${sub}`));
      console.log(dim('Usage: dynatrader workspace <list|create|show|validate> [args...]'));
    }
  }
}
