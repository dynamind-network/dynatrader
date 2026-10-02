import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

export type TrackedKind = 'asset' | 'sector' | 'theme' | 'strategy' | 'note';
export interface TrackedEntity { name: string; kind: TrackedKind; tags: string[]; createdAt: string; updatedAt: string; body: string; path: string; links: string[]; }

export class TrackedEntityStore {
  private readonly directory: string;
  constructor(workspacePath: string) { this.directory = join(workspacePath, 'tracked'); }

  async add(name: string, input: { kind?: TrackedKind; body?: string; tags?: string[] } = {}): Promise<TrackedEntity> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Entity name is required');
    const now = new Date().toISOString();
    const path = join(this.directory, `${fileSlug(cleanName)}.md`);
    const entity: TrackedEntity = { name: cleanName, kind: input.kind ?? 'note', tags: input.tags ?? [], createdAt: now, updatedAt: now, body: input.body ?? '', path, links: extractLinks(input.body ?? '') };
    await this.write(entity);
    return entity;
  }

  async get(name: string): Promise<TrackedEntity | null> {
    const filePath = join(this.directory, `${fileSlug(name)}.md`);
    try { return await this.parse(filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async list(): Promise<TrackedEntity[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.md'));
    return Promise.all(files.map((file) => this.parse(join(this.directory, file))));
  }

  async link(source: string, target: string): Promise<TrackedEntity> {
    const entity = await this.get(source);
    if (!entity) throw new Error(`Tracked entity not found: ${source}`);
    if (!(await this.get(target))) throw new Error(`Tracked entity not found: ${target}`);
    if (!entity.links.includes(target)) entity.body = `${entity.body.trim()}\n\nRelated: [[${target}]]\n`.trim();
    entity.links = extractLinks(entity.body); entity.updatedAt = new Date().toISOString();
    await this.write(entity); return entity;
  }

  async graph(): Promise<{ nodes: TrackedEntity[]; edges: Array<{ source: string; target: string }> }> {
    const nodes = await this.list();
    const names = new Set(nodes.map((node) => node.name));
    const edges = nodes.flatMap((node) => node.links.filter((target) => names.has(target)).map((target) => ({ source: node.name, target })));
    return { nodes, edges };
  }

  private async write(entity: TrackedEntity): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const metadata = { name: entity.name, kind: entity.kind, tags: entity.tags, createdAt: entity.createdAt, updatedAt: entity.updatedAt };
    await writeFile(entity.path, `---\n${YAML.stringify(metadata)}---\n\n${entity.body.trim()}\n`, 'utf8');
  }

  private async parse(path: string): Promise<TrackedEntity> {
    const raw = await readFile(path, 'utf8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) throw new Error(`Invalid tracked entity markdown: ${path}`);
    const metadata = YAML.parse(match[1] ?? '') as Record<string, unknown>;
    const body = (match[2] ?? '').trim();
    return { name: String(metadata.name), kind: metadata.kind as TrackedKind, tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [], createdAt: String(metadata.createdAt), updatedAt: String(metadata.updatedAt), body, path, links: extractLinks(body) };
  }
}

function fileSlug(value: string): string { const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return slug || 'entity'; }
function extractLinks(body: string): string[] { return [...body.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]!.trim()).filter((value, index, all) => all.indexOf(value) === index); }
