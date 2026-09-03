import { IssueBoard } from '../../issue-board/issue-board';
import type { IssueStatus } from '../../issue-board/issue-board';
import { TrackedEntityStore } from '../../tracking/tracked-entity';
import { Inbox } from '../../inbox/inbox';
import { bold, cyan, dim, green, red, yellow, printSeparator } from '../utils';

export async function cmdIssues(workspacePath: string, sub: string, args: string[]): Promise<void> {
  const board = new IssueBoard(workspacePath);
  if (sub === 'list') {
    const issues = await board.list({ status: args[0] as IssueStatus | undefined });
    console.log(bold(cyan('Issues'))); printSeparator();
    if (!issues.length) return console.log(yellow('  No issues found.'));
    for (const issue of issues) console.log(`  ${dim(issue.id)} [${issue.status}] ${issue.title} (${issue.priority})`);
    return;
  }
  if (sub === 'create') {
    const title = args.join(' ').trim();
    if (!title) return console.log(red('Usage: dynatrader issues create <title>'));
    const issue = await board.create({ title });
    return console.log(green(`Issue created: ${issue.id}`));
  }
  if (sub === 'show') {
    const issue = await board.get(args[0] ?? '');
    if (!issue) return console.log(red(`Issue not found: ${args[0] ?? ''}`));
    return console.log(`${bold(issue.title)}\n[${issue.status}] priority=${issue.priority}\n\n${issue.body}`);
  }
  if (sub === 'update') {
    const id = args[0]; const status = args[1] as IssueStatus | undefined;
    if (!id || !status || !IssueBoard.validStatuses().includes(status)) return console.log(red('Usage: dynatrader issues update <id> <status>'));
    await board.update(id, { status }); return console.log(green(`Issue ${id} updated to ${status}`));
  }
  console.log(red('Usage: dynatrader issues <list|create|show|update> [args]'));
}

export async function cmdTrack(workspacePath: string, sub: string, args: string[]): Promise<void> {
  const store = new TrackedEntityStore(workspacePath);
  if (sub === 'list') {
    const entities = await store.list();
    console.log(bold(cyan('Tracked Entities'))); printSeparator();
    for (const entity of entities) console.log(`  ${entity.name} (${entity.kind})${entity.links.length ? ` -> ${entity.links.join(', ')}` : ''}`);
    return;
  }
  if (sub === 'add') {
    const entity = await store.add(args.join(' ')); return console.log(green(`Tracked entity added: ${entity.name}`));
  }
  if (sub === 'show') {
    const entity = await store.get(args[0] ?? '');
    if (!entity) return console.log(red(`Tracked entity not found: ${args[0] ?? ''}`));
    return console.log(`${bold(entity.name)} (${entity.kind})\n\n${entity.body}`);
  }
  if (sub === 'link') {
    if (!args[0] || !args[1]) return console.log(red('Usage: dynatrader track link <source> <target>'));
    await store.link(args[0], args[1]); return console.log(green(`Linked ${args[0]} -> ${args[1]}`));
  }
  console.log(red('Usage: dynatrader track <add|list|show|link> [args]'));
}

export async function cmdInbox(workspacePath: string, sub: string, args: string[]): Promise<void> {
  const inbox = new Inbox(workspacePath);
  if (sub === 'list') {
    const entries = await inbox.list();
    console.log(bold(cyan('Inbox'))); printSeparator();
    for (const entry of entries) console.log(`  ${entry.id} [${entry.status}] ${entry.title}`);
    return;
  }
  if (sub === 'read') {
    const entry = await inbox.read(args[0] ?? '');
    if (!entry) return console.log(red(`Inbox entry not found: ${args[0] ?? ''}`));
    return console.log(`${bold(entry.title)}\n\n${entry.body}`);
  }
  if (sub === 'clear') return console.log(green(`Cleared ${await inbox.clear(args[0])} inbox entr${args[0] ? 'y' : 'ies'}.`));
  console.log(red('Usage: dynatrader inbox <list|read|clear> [id]'));
}
