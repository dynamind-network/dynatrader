import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { getHomeDirectory } from '../utils/constants.js';

function readOptionalFileSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function readFirstExistingFileSync(cwd: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const content = readOptionalFileSync(path.join(cwd, candidate));
    if (content) return content;
  }
  return null;
}

export interface WorkspaceIdentity {
  name?: string;
  role?: string;
  raw: string;
}

export function loadWorkspaceIdentitySync(cwd: string): WorkspaceIdentity | null {
  const raw = readFirstExistingFileSync(cwd, [
    'IDENTITY.md',
    'identity.md',
    path.join('.codex', 'IDENTITY.md'),
    path.join('.codex', 'identity.md'),
    path.join('.dynamind', 'IDENTITY.md'),
    path.join('.dynamind', 'identity.md'),
  ]);
  if (!raw) return null;

  const parsed = matter(raw);
  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const role = typeof frontmatter.role === 'string' ? frontmatter.role.trim() : '';

  return {
    name: name || undefined,
    role: role || undefined,
    raw,
  };
}

export function resolveWorkspaceAgentDirectories(cwd: string): {
  project: string[];
  global: string[];
} {
  const home = getHomeDirectory();
  return {
    project: [path.join(cwd, '.dynamind', 'agents'), path.join(cwd, '.codex', 'agents')],
    global: [path.join(home, '.dynamind', 'agents'), path.join(home, '.codex', 'agents')],
  };
}

export function buildWorkspaceContextPrompt(cwd: string): string {
  const sections: string[] = [];

  const identity = loadWorkspaceIdentitySync(cwd);
  if (identity) {
    const identityLine = [identity.name, identity.role].filter(Boolean).join(' — ');
    if (identityLine) {
      sections.push(`## Identity\n${identityLine}`);
    }
  }

  const coreFiles = [
    ['SOUL.md', 'soul.md'],
    ['IDENTITY.md', 'identity.md'],
    ['AGENTS.md', 'agents.md'],
    ['LEARNINGS.md', 'learnings.md'],
  ];
  for (const filenames of coreFiles) {
    const content = readFirstExistingFileSync(cwd, filenames);
    if (!content?.trim()) continue;
    sections.push(`## ${filenames[0]}\n${content.trim()}`);
  }

  const optionalFiles: Array<[string, string]> = [
    ['USER.md', 'user preferences'],
    ['RISK_PROFILE.md', 'risk policy'],
    ['TRADING_POLICY.md', 'trading policy'],
    ['HEARTBEAT.md', 'heartbeat checks'],
  ];

  const availableOnDemand: string[] = [];
  for (const [filename, label] of optionalFiles) {
    const content = readOptionalFileSync(path.join(cwd, filename));
    if (content?.trim()) {
      availableOnDemand.push(`- ${filename} (${label})`);
    }
  }

  if (availableOnDemand.length > 0) {
    sections.push(['## Available on demand', ...availableOnDemand].join('\n'));
  }

  if (sections.length === 0) {
    return '';
  }

  return [
    'Workspace instructions define identity, operating rules, and durable context.',
    'Prefer progressive disclosure: core files are always loaded, optional files are only referenced when needed.',
    '',
    ...sections,
  ].join('\n');
}
