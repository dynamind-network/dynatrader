import fs from 'fs/promises';
import path from 'path';

export interface WorkspaceIdentity {
  name?: string;
  role?: string;
  raw: string;
}

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  const data: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) data[key] = parseFrontmatterScalar(value);
  }
  return data;
}

export async function loadWorkspaceIdentity(workspacePath: string): Promise<WorkspaceIdentity | null> {
  const filePath = path.join(workspacePath, 'IDENTITY.md');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) {
      return { raw };
    }
    const fm = parseMarkdownFrontmatter(match[1] ?? '');
    return {
      name: fm.name,
      role: fm.role,
      raw,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
