import type { ConversationMessageRow, ConversationSessionRow, StateDb } from '@dyna/core/cli';
import { red, dim, bold } from '../utils';

type SessionExportFormat = 'markdown' | 'json';

function parseMessageContent(row: ConversationMessageRow): string {
  try {
    const parsed: unknown = JSON.parse(row.parts);
    if (!Array.isArray(parsed)) return redactSecrets(String(parsed ?? ''));
    return redactSecrets(parsed.map((part: unknown) => {
      if (!part || typeof part !== 'object') return String(part ?? '');
      const item = part as Record<string, unknown>;
      if (typeof item.content === 'string') return item.content;
      if (typeof item.text === 'string') return item.text;
      return JSON.stringify(item);
    }).filter(Boolean).join('\n'));
  } catch {
    return redactSecrets(row.parts);
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b([\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|bot[_-]?token))\b\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|tsf_[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]');
}

function sessionJson(session: ConversationSessionRow, messages: ConversationMessageRow[]) {
  return {
    id: session.id,
    title: session.title,
    slug: session.slug,
    status: session.status,
    parent_id: session.parent_id,
    created_at: new Date(session.created_at).toISOString(),
    updated_at: new Date(session.updated_at).toISOString(),
    messages: messages.map((row) => ({
      role: row.role,
      content: parseMessageContent(row),
      created_at: new Date(row.created_at).toISOString(),
      token_count: row.token_count,
    })),
  };
}

function renderMarkdown(session: ConversationSessionRow, messages: ConversationMessageRow[]): string {
  const lines = [
    `# ${session.title || 'Untitled session'}`,
    '',
    `- Session ID: ${session.id}`,
    `- Status: ${session.status}`,
    `- Created: ${new Date(session.created_at).toISOString()}`,
    `- Updated: ${new Date(session.updated_at).toISOString()}`,
  ];
  if (session.parent_id) lines.push(`- Parent session: ${session.parent_id}`);
  lines.push('', '## Conversation', '');
  for (const row of messages) {
    lines.push(`### ${row.role} · ${new Date(row.created_at).toISOString()}`, '', parseMessageContent(row), '');
  }
  return lines.join('\n');
}

export function cmdSessions(db: StateDb, subcommand: string, args: string[], flags: Record<string, string | boolean> = {}): void {
  if (subcommand === 'list') {
    const rows = db.listConversationSessions();
    if (rows.length === 0) {
      console.log('No saved conversations.');
      return;
    }
    console.log(`${bold('ID'.padEnd(28))} ${bold('MESSAGES'.padStart(8))} ${bold('UPDATED'.padEnd(22))} TITLE`);
    for (const row of rows) {
      console.log(`${row.id.slice(0, 28).padEnd(28)} ${String(row.message_count ?? 0).padStart(8)} ${new Date(row.updated_at).toISOString().slice(0, 19).replace('T', ' ').padEnd(22)} ${row.title}`);
    }
    return;
  }

  const sessionId = args[0];
  if (!sessionId) {
    console.error(red(`Usage: dynatrader sessions ${subcommand} <session-id>`));
    process.exitCode = 2;
    return;
  }
  const session = db.getConversationSession(sessionId);
  if (!session) {
    console.error(red(`Conversation not found: ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const messages = db.getConversationMessages(sessionId);
  if (subcommand === 'show') {
    console.log(renderMarkdown(session, messages));
    return;
  }
  if (subcommand === 'export') {
    const format = typeof flags.format === 'string' ? flags.format : 'markdown';
    if (format !== 'json' && format !== 'markdown') {
      console.error(red(`Unsupported session export format '${format}'. Choose markdown or json.`));
      process.exitCode = 2;
      return;
    }
    const output = format === 'json'
      ? JSON.stringify(sessionJson(session, messages), null, 2)
      : renderMarkdown(session, messages);
    process.stdout.write(`${output}\n`);
    return;
  }
  console.error(red(`Unknown sessions subcommand '${subcommand}'. Use list, show, or export.`));
  console.error(dim('Usage: dynatrader sessions <list|show|export> [session-id] [--format markdown|json]'));
  process.exitCode = 2;
}
