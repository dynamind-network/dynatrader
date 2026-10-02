import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';

export class GrepTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'grep',
    description: 'Search text across repository files without modifying them',
    category: 'file',
    inputSchema: { pattern: 'string', path: 'string?', caseSensitive: 'boolean?' },
    outputSchema: { matches: 'object[]' },
    permissionsRequired: ['tool.read'],
    sideEffects: [],
    riskLevel: 'low',
    readOnly: true,
    timeoutMs: 15000,
    canRunInParallel: true,
  };

  constructor(
    private readonly allowedDirectories: readonly string[] = [process.cwd()],
    private readonly workspaceRoot: string = allowedDirectories[0] ?? process.cwd(),
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    try {
      const query = String(call.args.pattern ?? '');
      if (!query) throw new Error('pattern must not be empty');
      const rootInput = String(call.args.path ?? this.workspaceRoot);
      const root = path.isAbsolute(rootInput)
        ? path.normalize(rootInput)
        : path.resolve(this.workspaceRoot, rootInput);
      if (!this.allowedDirectories.some((dir) => root === path.resolve(dir) || root.startsWith(path.resolve(dir) + path.sep))) {
        throw new Error('path is outside allowed directories');
      }
      const needle = call.args.caseSensitive ? query : query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (matches.length >= 500) return;
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else {
            const stat = await fs.stat(full);
            if (stat.size > 1024 * 1024) continue;
            let content: string;
            try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
            for (const [index, line] of content.split(/\r?\n/).entries()) {
              const haystack = call.args.caseSensitive ? line : line.toLowerCase();
              if (haystack.includes(needle)) matches.push({ path: path.relative(root, full).replace(/\\/g, '/'), line: index + 1, text: line.slice(0, 500) });
              if (matches.length >= 500) break;
            }
          }
        }
      };
      await walk(root);
      return { success: true, data: { matches }, durationMs: Date.now() - started, truncated: matches.length >= 500 };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, truncated: false };
    }
  }
}
