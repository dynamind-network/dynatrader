import * as fs from 'fs';
import * as path from 'path';

export interface MentionResult {
  type: 'file' | 'folder' | 'url' | 'problems' | 'unknown';
  label: string;
  content: string;
}

export function resolveMentions(
  text: string,
  cwd: string
): { resolved: string; mentions: MentionResult[] } {
  const mentions: MentionResult[] = [];
  let resolved = text;

  const patterns = [
    { regex: /@file\s+([^\s]+)/g, handler: resolveFileMention },
    { regex: /@folder\s+([^\s]+)/g, handler: resolveFolderMention },
    { regex: /@url\s+(https?:\/\/[^\s]+)/g, handler: resolveUrlMention },
    { regex: /@problems/g, handler: resolveProblemsMention },
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const result = pattern.handler(match[1] || '', cwd);
      if (result) {
        mentions.push(result);
        resolved = resolved.replace(match[0], `\n[${result.label}]\n${result.content}\n[/${result.label}]\n`);
      }
    }
  }

  return { resolved, mentions };
}

function resolveFileMention(filePath: string, cwd: string): MentionResult | null {
  const fullPath = path.resolve(cwd, filePath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return null;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const ext = path.extname(filePath);
    return {
      type: 'file',
      label: `file:${filePath}`,
      content,
    };
  } catch {
    return null;
  }
}

function resolveFolderMention(folderPath: string, cwd: string): MentionResult | null {
  const fullPath = path.resolve(cwd, folderPath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) return null;
    const tree = buildFileTree(fullPath, 3);
    return {
      type: 'folder',
      label: `folder:${folderPath}`,
      content: tree,
    };
  } catch {
    return null;
  }
}

function resolveUrlMention(url: string, _cwd: string): MentionResult | null {
  return {
    type: 'url',
    label: `url:${url}`,
    content: `[URL content would be fetched at runtime: ${url}]`,
  };
}

function resolveProblemsMention(_cwd: string): MentionResult | null {
  return {
    type: 'problems',
    label: 'problems',
    content: '[No LSP diagnostics available]',
  };
}

function buildFileTree(dirPath: string, maxDepth: number, currentDepth = 0): string {
  if (currentDepth >= maxDepth) return '';
  const lines: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const indent = '  '.repeat(currentDepth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        lines.push(buildFileTree(path.join(dirPath, entry.name), maxDepth, currentDepth + 1));
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  } catch {
    return '';
  }
  return lines.join('\n');
}
