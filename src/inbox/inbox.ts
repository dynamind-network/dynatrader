import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

export interface InboxEntry { id: string; title: string; source?: string; status: 'unread' | 'read'; createdAt: string; metadata: Record<string, unknown>; body: string; path: string; }

export class Inbox {
  private readonly directory: string;
  constructor(workspacePath: string) { this.directory = join(workspacePath, 'inbox'); }

  async deliver(input: { title: string; body: string; source?: string; metadata?: Record<string, unknown> }): Promise<InboxEntry> {
    if (!input.title.trim()) throw new Error('Inbox title is required');
    const id = randomUUID(); const createdAt = new Date().toISOString();
    const entry: InboxEntry = { id, title: input.title.trim(), ...(input.source ? { source: input.source } : {}), status: 'unread', createdAt, metadata: input.metadata ?? {}, body: input.body, path: join(this.directory, `${createdAt.replace(/[^0-9]/g, '')}-${id}.md`) };
    await this.write(entry); return entry;
  }

  async list(status?: InboxEntry['status']): Promise<InboxEntry[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.md'));
    const entries = await Promise.all(files.map((file) => this.parse(join(this.directory, file))));
    return entries.filter((entry) => !status || entry.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(id: string, markRead = true): Promise<InboxEntry | null> {
    const entry = (await this.list()).find((item) => item.id === id);
    if (!entry) return null;
    if (markRead && entry.status !== 'read') { entry.status = 'read'; await this.write(entry); }
    return entry;
  }

  async clear(id?: string): Promise<number> {
    const entries = await this.list();
    const selected = id ? entries.filter((entry) => entry.id === id) : entries;
    await Promise.all(selected.map((entry) => unlink(entry.path)));
    return selected.length;
  }

  private async write(entry: InboxEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const metadata = { id: entry.id, title: entry.title, ...(entry.source ? { source: entry.source } : {}), status: entry.status, createdAt: entry.createdAt, metadata: entry.metadata };
    await writeFile(entry.path, `---\n${YAML.stringify(metadata)}---\n\n${entry.body.trim()}\n`, 'utf8');
  }

  private async parse(path: string): Promise<InboxEntry> {
    const raw = await readFile(path, 'utf8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) throw new Error(`Invalid inbox markdown: ${path}`);
    const metadata = YAML.parse(match[1] ?? '') as Record<string, unknown>;
    return { id: String(metadata.id), title: String(metadata.title), ...(metadata.source ? { source: String(metadata.source) } : {}), status: metadata.status === 'read' ? 'read' : 'unread', createdAt: String(metadata.createdAt), metadata: (metadata.metadata as Record<string, unknown>) ?? {}, body: (match[2] ?? '').trim(), path };
  }
}
