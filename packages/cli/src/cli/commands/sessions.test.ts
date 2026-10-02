import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateDb } from '../../../../core/src/state-db/state-db';
import { cmdSessions } from './sessions';

const dirs: string[] = [];
const originalLog = console.log;
const originalWrite = process.stdout.write;
let output = '';

afterEach(async () => {
  console.log = originalLog;
  process.stdout.write = originalWrite;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'dynatrader-cli-sessions-'));
  dirs.push(path);
  const db = new StateDb(path);
  db.saveConversationSession({
    id: 'session-abc', parent_id: null, title: 'Research notes', slug: 'research-notes',
    status: 'closed', metadata: JSON.stringify({ persona: 'researcher' }), created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000,
  });
  db.saveConversationMessage({
    id: 'message-1', session_id: 'session-abc', role: 'user',
    parts: JSON.stringify([{ type: 'text', content: 'Find the evidence.' }]), token_count: 4, created_at: 1_700_000_000_500,
  });
  db.saveConversationMessage({
    id: 'message-2', session_id: 'session-abc', role: 'assistant',
    parts: JSON.stringify([{ type: 'text', content: 'Evidence found. api_key=syntheticSecret123 OPENAI_API_KEY=syntheticOpenAiSecret TELEGRAM_BOT_TOKEN=syntheticTelegramSecret Bearer syntheticBearer456' }]), token_count: 5, created_at: 1_700_000_001_000,
  });
  return db;
}

function capture() {
  output = '';
  console.log = ((value?: unknown) => { output += `${String(value ?? '')}\n`; }) as typeof console.log;
  process.stdout.write = ((value: string | Uint8Array) => { output += String(value); return true; }) as typeof process.stdout.write;
}

describe('sessions CLI', () => {
  it('lists persisted conversation sessions', async () => {
    const db = await fixture();
    capture();
    cmdSessions(db, 'list', []);
    expect(output).toContain('session-abc');
    expect(output).toContain('Research notes');
    db.close();
  });

  it('shows messages and exports valid JSON/Markdown transcripts', async () => {
    const db = await fixture();
    capture();
    cmdSessions(db, 'show', ['session-abc']);
    expect(output).toContain('Find the evidence.');
    expect(output).toContain('Evidence found.');

    capture();
    cmdSessions(db, 'export', ['session-abc'], { format: 'json' });
    const exported = JSON.parse(output) as { messages: Array<{ content: string }>; metadata: unknown };
    expect(exported.messages.map((message) => message.content)).toEqual(['Find the evidence.', 'Evidence found. api_key=[REDACTED] OPENAI_API_KEY=[REDACTED] TELEGRAM_BOT_TOKEN=[REDACTED] Bearer [REDACTED]']);
    expect(JSON.stringify(exported)).not.toContain('syntheticSecret123');
    expect(JSON.stringify(exported)).not.toContain('syntheticOpenAiSecret');
    expect(JSON.stringify(exported)).not.toContain('syntheticTelegramSecret');
    expect(JSON.stringify(exported)).not.toContain('researcher');

    capture();
    cmdSessions(db, 'export', ['session-abc'], { format: 'markdown' });
    expect(output).toContain('# Research notes');
    expect(output).toContain('### assistant');
    db.close();
  });
});
