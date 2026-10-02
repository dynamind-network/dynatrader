import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolCall, ToolDefinition, ToolHandler, ToolResult } from '@dyna/contracts';

export class GlobTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'glob',
    description: 'List files recursively using a glob pattern without modifying the filesystem',
    category: 'file',
    inputSchema: { pattern: 'string', path: 'string?' },
    outputSchema: { files: 'string[]' },
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
      const pattern = String(call.args.pattern ?? '').trim();
      if (!pattern) throw new Error('pattern must not be empty');
      const rootInput = String(call.args.path ?? this.workspaceRoot);
      const root = path.isAbsolute(rootInput)
        ? path.normalize(rootInput)
        : path.resolve(this.workspaceRoot, rootInput);
      if (!this.allowedDirectories.some((dir) => root === path.resolve(dir) || root.startsWith(path.resolve(dir) + path.sep))) {
        throw new Error('path is outside allowed directories');
      }
      const regex = new RegExp('^' + pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/§§/g, '.*') + '$', 'i');
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else {
            const relative = path.relative(root, full).replace(/\\/g, '/');
            if (regex.test(relative)) files.push(relative);
            if (files.length >= 2000) return;
          }
        }
      };
      await walk(root);
      return { success: true, data: { files }, durationMs: Date.now() - started, truncated: files.length >= 2000 };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, truncated: false };
    }
  }
}
