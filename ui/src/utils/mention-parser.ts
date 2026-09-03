/**
 * Mention Parser
 * Parses @subagent mentions from user input for direct subagent dispatch
 * Also handles @file references for attaching file contents
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PathSecurity } from '../tools/path-security.js';
import * as picomatch from 'picomatch';

export interface ParsedMention {
  agentName: string;
  task: string;
}

export interface MentionParseResult {
  isMention: boolean;
  type?: 'agent' | 'file' | 'mcp-resource';
  mention?: ParsedMention;
  file?: FileMentionParseResult;
  error?: string;
}

export interface FileMentionParseResult {
  filename: string;
  lineStart?: number;
  lineEnd?: number;
  isQuoted: boolean;
  original: string;
}

export interface FileAttachment {
  type: 'file';
  filename: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

const MAX_FILE_LINES = 2000;
const MAX_FILE_SIZE = 50 * 1024;

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function extractAtMentionedFiles(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g;
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g;

  const quotedMatches: string[] = [];
  const regularMatches: string[] = [];

  let match;
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]);
    }
  }

  const regularMatchArray = content.match(regularAtMentionRegex) || [];
  regularMatchArray.forEach((m) => {
    const filename = m.slice(m.indexOf('@') + 1);
    if (!filename.startsWith('"')) {
      regularMatches.push(filename);
    }
  });

  return uniq([...quotedMatches, ...regularMatches]);
}

export function extractMcpResourceMentions(content: string): string[] {
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g;
  const matches = content.match(atMentionRegex) || [];
  return uniq(matches.map((m) => m.slice(m.indexOf('@') + 1)));
}

export function extractAgentMentions(content: string): string[] {
  const results: string[] = [];

  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g;
  let match;
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2]);
    }
  }

  const unquotedAgentRegex = /(^|\s)@([\w:.@-]+)/g;
  const unquotedMatches = content.match(unquotedAgentRegex) || [];
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1));
  }

  return uniq(results);
}

export function parseAtMentionedFileLines(mention: string): FileMentionParseResult {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/);

  if (!match) {
    return {
      filename: mention,
      isQuoted: false,
      original: mention,
    };
  }

  const [, filename, lineStartStr, lineEndStr] = match;
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined;
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart;

  return {
    filename: filename ?? mention,
    lineStart,
    lineEnd,
    isQuoted: false,
    original: mention,
  };
}

export function isFileMention(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('@')) return false;

  const afterAt = trimmed.slice(1).split(/\s/)[0];

  if (afterAt.includes(':') && !afterAt.includes('#')) return false;
  return true;
}

export function parseFileMention(input: string, workingDirectory: string): MentionParseResult {
  const trimmed = input.trim();

  if (!trimmed.startsWith('@')) {
    return { isMention: false };
  }

  const afterAt = trimmed.slice(1);

  if (afterAt.includes(':') && !afterAt.includes('#')) {
    return {
      isMention: true,
      type: 'mcp-resource',
    };
  }

  const parsed = parseAtMentionedFileLines(afterAt);

  try {
    const absolutePath = PathSecurity.resolveWithinWorkspace(parsed.filename, workingDirectory);

    return {
      isMention: true,
      type: 'file',
      file: {
        ...parsed,
        filename: absolutePath,
      },
    };
  } catch (err) {
    return {
      isMention: true,
      type: 'file',
      error: `Invalid file path: ${(err as Error).message}`,
    };
  }
}

export async function generateFileAttachment(
  absolutePath: string,
  workingDirectory: string,
  options?: {
    offset?: number;
    limit?: number;
  }
): Promise<FileAttachment | null> {
  try {
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      return null;
    }

    if (stats.size > MAX_FILE_SIZE) {
      return {
        type: 'file',
        filename: absolutePath,
        displayPath: path.relative(workingDirectory, absolutePath),
        content: `[File too large: ${Math.round(stats.size / 1024)}KB - showing first 50KB]`,
        truncated: true,
      };
    }

    let content = await fs.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n');

    const offset = options?.offset ?? 1;
    const limit = options?.limit ?? MAX_FILE_LINES;

    const startLine = Math.max(1, offset) - 1;
    const endLine = Math.min(startLine + limit, lines.length);
    const selectedLines = lines.slice(startLine, endLine);

    content = selectedLines.join('\n');

    const truncated = lines.length > limit || content.length > MAX_FILE_SIZE;

    return {
      type: 'file',
      filename: absolutePath,
      displayPath: path.relative(workingDirectory, absolutePath),
      content: content,
      truncated,
    };
  } catch {
    return null;
  }
}

export async function processFileMentions(
  content: string,
  workingDirectory: string
): Promise<FileAttachment[]> {
  const filePaths = extractAtMentionedFiles(content);
  const attachments: FileAttachment[] = [];

  for (const filePath of filePaths) {
    const parsed = parseAtMentionedFileLines(filePath);

    try {
      const absolutePath = PathSecurity.resolveWithinWorkspace(parsed.filename, workingDirectory);

      const attachment = await generateFileAttachment(absolutePath, workingDirectory, {
        offset: parsed.lineStart,
        limit: parsed.lineEnd ? parsed.lineEnd - (parsed.lineStart ?? 1) + 1 : 50,
      });

      if (attachment) {
        attachments.push(attachment);
      }
    } catch {
      // Skip files that can't be resolved
    }
  }

  return attachments;
}

export async function getFileSuggestions(
  input: string,
  workingDirectory: string,
  maxResults: number = 10
): Promise<string[]> {
  const trimmed = input.trim();

  if (!trimmed.startsWith('@')) {
    return [];
  }

  const partial = trimmed.slice(1).toLowerCase();

  if (!partial || partial.length < 1) {
    return [];
  }

  try {
    const { glob } = await import('glob');
    const pattern =
      partial.includes('*') || partial.includes('?') ? `**/${partial}` : `**/*${partial}*`;

    const matches = await glob(pattern, {
      cwd: workingDirectory,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'],
      absolute: false,
      stat: false,
    });

    return matches.slice(0, maxResults);
  } catch {
    return [];
  }
}

export function formatFileMentionHelp(): string {
  return `File References:
  @filename.txt - Attach file contents
  @"path with spaces.txt" - Quoted path
  @file.txt#L10 - Start at line 10
  @file.txt#L10-20 - Lines 10 to 20

Agents:
  @name task - Dispatch to subagent

MCP Resources:
  @server:resource - MCP resource reference`;
}

/**
 * Parse @mention syntax from user input
 *
 * Supported formats:
 * - @name task description here
 * - @name: task description here
 *
 * @param input - User input string
 * @param validAgents - List of valid agent names to validate against
 * @returns Parse result with mention details or error
 */
export function parseMention(
  input: string,
  validAgents: string[],
  workingDirectory?: string
): MentionParseResult {
  const trimmed = input.trim();

  if (!trimmed.startsWith('@')) {
    return { isMention: false };
  }

  const afterAt = trimmed.slice(1);

  const mentionPattern = /^([^\s:#]+)(?::?\s*(.*))?$/;
  const match = trimmed.slice(1).match(mentionPattern);
  const candidateName = match?.[1]?.trim();
  const task = match?.[2]?.trim() ?? '';

  if (candidateName && validAgents.includes(candidateName)) {
    if (!task) {
      return {
        isMention: true,
        error: `Please provide a task for @${candidateName}. Example: @${candidateName} analyze the current workspace`,
      };
    }

    return {
      isMention: true,
      type: 'agent',
      mention: {
        agentName: candidateName,
        task,
      },
    };
  }

  if (afterAt.includes(':') && !afterAt.includes('#')) {
    return {
      isMention: true,
      type: 'mcp-resource',
    };
  }

  if (workingDirectory) {
    return parseFileMention(input, workingDirectory);
  }

  return {
    isMention: true,
    type: 'file',
  };
}

/**
 * Get autocomplete suggestions for @ mentions
 *
 * @param input - Current user input
 * @param agents - Available agents with descriptions
 * @returns Matching agent suggestions
 */
export function getMentionSuggestions(
  input: string,
  agents: Array<{ name: string; description: string }>,
  _workingDirectory?: string
): Array<{ name: string; description: string }> {
  const trimmed = input.trim();

  if (!trimmed.startsWith('@')) {
    return [];
  }

  const partial = trimmed.slice(1).split(/[\s:]/)[0].toLowerCase();

  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().startsWith(partial) || agent.name.toLowerCase().includes(partial)
  );
}

/**
 * Format available agents as help text
 */
export function formatAgentHelp(agents: Array<{ name: string; description: string }>): string {
  const lines = ['Available agents:'];
  for (const agent of agents) {
    lines.push(`  @${agent.name} - ${agent.description}`);
  }
  return lines.join('\n');
}
