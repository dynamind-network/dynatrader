import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

export type IssueStatus = 'triage' | 'todo' | 'in_progress' | 'blocked' | 'done' | 'archived';
export type IssuePriority = 'low' | 'medium' | 'high' | 'critical';

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assignee?: string;
  schedule?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
  path: string;
}

export interface IssueCreateInput {
  id?: string;
  title: string;
  body?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string;
  schedule?: string;
  tags?: string[];
}

const STATUSES: IssueStatus[] = ['triage', 'todo', 'in_progress', 'blocked', 'done', 'archived'];
const PRIORITIES: IssuePriority[] = ['low', 'medium', 'high', 'critical'];

export class IssueBoard {
  private readonly directory: string;

  constructor(workspacePath: string) {
    this.directory = join(workspacePath, 'issues');
  }

  async create(input: IssueCreateInput): Promise<Issue> {
    if (!input.title.trim()) throw new Error('Issue title is required');
    const now = new Date().toISOString();
    const id = this.safeId(input.id ?? `${Date.now()}-${slug(input.title)}`);
    const issue: Issue = {
      id, title: input.title.trim(), body: input.body ?? '',
      status: input.status ?? 'triage', priority: input.priority ?? 'medium',
      ...(input.assignee ? { assignee: input.assignee } : {}),
      ...(input.schedule ? { schedule: input.schedule } : {}),
      tags: input.tags ?? [], createdAt: now, updatedAt: now,
      path: join(this.directory, `${id}.md`),
    };
    await this.write(issue);
    return issue;
  }

  async get(id: string): Promise<Issue | null> {
    const safeId = this.safeId(id);
    try { return this.parse(join(this.directory, `${safeId}.md`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(filter: { status?: IssueStatus; tag?: string } = {}): Promise<Issue[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.md'));
    const issues = await Promise.all(files.map((file) => this.parse(join(this.directory, file))));
    return issues.filter((issue) => (!filter.status || issue.status === filter.status) && (!filter.tag || issue.tags.includes(filter.tag)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async update(id: string, patch: Partial<Pick<Issue, 'title' | 'body' | 'status' | 'priority' | 'assignee' | 'schedule' | 'tags'>>): Promise<Issue> {
    const issue = await this.get(id);
    if (!issue) throw new Error(`Issue not found: ${id}`);
    const updated: Issue = { ...issue, ...patch, updatedAt: new Date().toISOString() };
    await this.write(updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const issue = await this.get(id);
    if (!issue) return false;
    await unlink(issue.path);
    return true;
  }

  static validStatuses(): readonly IssueStatus[] { return STATUSES; }
  static validPriorities(): readonly IssuePriority[] { return PRIORITIES; }

  private async write(issue: Issue): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const frontmatter = {
      id: issue.id, title: issue.title, status: issue.status, priority: issue.priority,
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(issue.schedule ? { schedule: issue.schedule } : {}), tags: issue.tags,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    };
    await writeFile(issue.path, `---\n${YAML.stringify(frontmatter)}---\n\n${issue.body.trim()}\n`, 'utf8');
  }

  private async parse(filePath: string): Promise<Issue> {
    const raw = await readFile(filePath, 'utf8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) throw new Error(`Invalid issue markdown: ${filePath}`);
    const metadata = YAML.parse(match[1] ?? '') as Record<string, unknown>;
    const status = metadata.status as IssueStatus;
    const priority = metadata.priority as IssuePriority;
    if (!STATUSES.includes(status) || !PRIORITIES.includes(priority)) throw new Error(`Invalid issue metadata: ${filePath}`);
    return {
      id: String(metadata.id), title: String(metadata.title), status, priority,
      ...(metadata.assignee ? { assignee: String(metadata.assignee) } : {}),
      ...(metadata.schedule ? { schedule: String(metadata.schedule) } : {}),
      tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
      createdAt: String(metadata.createdAt), updatedAt: String(metadata.updatedAt),
      body: (match[2] ?? '').trim(), path: filePath,
    };
  }

  private safeId(id: string): string {
    const safe = id.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!safe || safe === '.' || safe === '..') throw new Error('Invalid issue id');
    return safe;
  }
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'issue'; }
