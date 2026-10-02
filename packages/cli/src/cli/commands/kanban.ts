/**
 * CLI Command: kanban
 */

import { AgentTaskService, KanbanBoard, KanbanTaskCompatibilityAdapter, StateDb, getStatePath } from '@dyna/core/cli';
import type { TaskStatus, Task } from '@dyna/core/cli';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { bold, cyan, green, red, yellow, dim, formatDate, printSeparator } from '../utils';

export async function cmdKanban(
  workspacePath: string,
  sub: string,
  args: string[],
  statePath = getStatePath(),
): Promise<void> {
  const db = new StateDb(statePath);
  const tasks = new AgentTaskService(db);
  const board = new KanbanTaskCompatibilityAdapter(tasks);
  const projectId = basename(workspacePath);
  let legacyBoard: KanbanBoard | undefined;

  try {
    // Import from the legacy DB only when it already exists. The adapter is
    // repeat-safe and never creates or deletes the source database.
    if (existsSync(join(workspacePath, 'kanban.db'))) {
      legacyBoard = new KanbanBoard(workspacePath);
      board.importAllBoard(legacyBoard, projectId);
    }
    switch (sub) {
      case 'list': {
        const statusFilter = args[0] as TaskStatus | undefined;
        console.log();
        console.log(bold(cyan('Kanban Tasks')));
        if (statusFilter) console.log(dim(`  Filter: status = ${statusFilter}`));
        printSeparator();

        const listedTasks = board.listTasks({ workspaceId: projectId, ...(statusFilter ? { status: statusFilter } : {}) });
        if (listedTasks.length === 0) {
          console.log(yellow('  No tasks found.'));
          console.log();
          return;
        }

        const grouped = new Map<string, Task[]>();
        for (const task of listedTasks) {
          const group = grouped.get(task.status) ?? [];
          group.push(task);
          grouped.set(task.status, group);
        }

        for (const [status, statusTasks] of grouped) {
          const statusLabel = status === 'done' || status === 'archived'
            ? green(status)
            : status === 'blocked'
              ? red(status)
              : status === 'running'
                ? cyan(status)
                : yellow(status);
          console.log(`  ${bold(statusLabel)} (${statusTasks.length}):`);
          for (const task of statusTasks) {
            const assignee = task.assignedTo ? dim(` [${task.assignedTo}]`) : '';
            console.log(`    ${dim(task.id.slice(0, 8))} ${task.title}${assignee}`);
          }
          console.log();
        }
        break;
      }

      case 'show': {
        const taskId = args[0];
        if (!taskId) {
          console.log(red('Error: taskId is required.'));
          console.log(dim('Usage: dynatrader kanban show <taskId>'));
          return;
        }

        const task = board.getTask(taskId);
        if (!task) {
          console.log(red(`Task not found: ${taskId}`));
          return;
        }

        console.log();
        console.log(bold(cyan('Task Details')));
        printSeparator();
        console.log(`  ID:          ${dim(task.id)}`);
        console.log(`  Title:       ${bold(task.title)}`);
        console.log(`  Status:      ${task.status}`);
        console.log(`  Priority:    ${task.priority}`);
        console.log(`  Assignee:    ${task.assignedTo ?? dim('unassigned')}`);
        console.log(`  Tags:        ${task.tags.length > 0 ? task.tags.join(', ') : dim('none')}`);
        console.log(`  Created:     ${formatDate(new Date(task.createdAt))}`);
        console.log(`  Updated:     ${formatDate(new Date(task.updatedAt))}`);
        if (task.resolvedAt) console.log(`  Resolved:    ${formatDate(new Date(task.resolvedAt))}`);
        if (task.description) console.log(`  Description: ${task.description}`);

        const links = board.getTaskLinks(taskId);
        if (links.length > 0) {
          console.log();
          console.log(bold('  Linked Tasks:'));
          for (const link of links) {
            console.log(`    ${dim(link.id.slice(0, 8))} ${link.title} (${link.status})`);
          }
        }
        console.log();
        break;
      }

      case 'create': {
        const title = args.slice(0).join(' ');
        if (!title) {
          console.log(red('Error: title is required.'));
          console.log(dim('Usage: dynatrader kanban create <title>'));
          return;
        }

        const task = board.createTask({
          workspaceId: projectId,
          title,
          description: '',
        });
        console.log(green(`Task created: ${task.id}`));
        console.log(dim(`  Title:  ${task.title}`));
        console.log(dim(`  Status: ${task.status}`));
        break;
      }

      case 'claim': {
        const taskId = args[0];
        const assignee = args[1] ?? 'current-agent';
        if (!taskId) {
          console.log(red('Error: taskId is required.'));
          console.log(dim('Usage: dynatrader kanban claim <taskId> [assignee]'));
          return;
        }

        const task = board.claimTask(taskId, assignee);
        if (!task.success) {
          console.log(red(`Error: ${task.error ?? 'Failed to claim task'}`));
          break;
        }
        const claimed = board.getTask(taskId);
        console.log(green(`Task claimed: ${claimed?.title ?? taskId} by ${assignee}`));
        break;
      }

      case 'transition': {
        const taskId = args[0];
        const newStatus = args[1] as TaskStatus | undefined;
        if (!taskId || !newStatus) {
          console.log(red('Error: taskId and status are required.'));
          console.log(dim('Usage: dynatrader kanban transition <taskId> <status>'));
          console.log(dim('Status options: triage, todo, ready, running, done, archived, blocked'));
          return;
        }

        const validStatuses: TaskStatus[] = ['triage', 'todo', 'ready', 'running', 'done', 'archived', 'blocked'];
        if (!validStatuses.includes(newStatus)) {
          console.log(red(`Invalid status: ${newStatus}`));
          console.log(dim(`Valid statuses: ${validStatuses.join(', ')}`));
          return;
        }

        board.transitionTask(taskId, newStatus);
        console.log(green(`Task ${taskId.slice(0, 8)} transitioned to ${newStatus}`));
        break;
      }

      case 'link': {
        const fromId = args[0];
        const toId = args[1];
        const label = args[2] ?? 'related';
        if (!fromId || !toId) {
          console.log(red('Error: fromId and toId are required.'));
          console.log(dim('Usage: dynatrader kanban link <fromId> <toId> [type]'));
          return;
        }

        board.linkTasks(fromId, toId, label);
        console.log(green(`Tasks linked: ${fromId.slice(0, 8)} <--> ${toId.slice(0, 8)} (${label})`));
        break;
      }

      default: {
        console.log(red(`Unknown kanban subcommand: ${sub}`));
        console.log(dim('Usage: dynatrader kanban <list|show|create|claim|transition|link> [args...]'));
      }
    }
  } finally {
    legacyBoard?.close();
    db.close();
  }
}
