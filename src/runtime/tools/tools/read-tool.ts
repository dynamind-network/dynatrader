import { promises as fs } from 'fs';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface ReadToolConfig {
  allowedDirectories?: string[];
  workspaceRoot?: string;
  maxFileSize?: number;
}

export class ReadTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'read',
    description: 'Read files from the filesystem',
    category: 'file',
    inputSchema: { path: 'string', mode: 'string?', maxSize: 'number?' },
    outputSchema: { content: 'string', mode: 'string' },
    permissionsRequired: ['tool.read'],
    sideEffects: [],
    riskLevel: 'low',
    readOnly: true,
    timeoutMs: 10000,
  };

  private allowedDirectories: readonly string[];
  private workspaceRoot: string;
  private maxFileSize: number;

  constructor(config?: ReadToolConfig) {
    this.allowedDirectories = config?.allowedDirectories ?? [process.cwd()];
    this.workspaceRoot = config?.workspaceRoot ?? this.allowedDirectories[0] ?? process.cwd();
    this.maxFileSize = config?.maxFileSize ?? 1024 * 1024; // 1MB default
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const filePath = call.args.path;
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return {
          success: false,
          error: 'Path must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const mode = (call.args.mode as string | undefined) ?? 'text';
      const maxSize = (call.args.maxSize as number | undefined) ?? this.maxFileSize;

      const resolved = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(this.workspaceRoot, filePath);
      this.validatePath(resolved);

      let stats: import('fs').Stats;
      try {
        stats = await fs.stat(resolved);
      } catch {
        return {
          success: false,
          error: `File not found: ${filePath}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (!stats.isFile()) {
        return {
          success: false,
          error: `Path is not a file: ${filePath}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (stats.size > maxSize) {
        return {
          success: false,
          error: `File too large (${stats.size} bytes > ${maxSize} bytes max). Use maxSize parameter to increase limit.`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (mode === 'binary') {
        const buffer = await fs.readFile(resolved);
        return {
          success: true,
          data: { content: buffer.toString('base64'), mode: 'binary' },
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const content = await fs.readFile(resolved, 'utf-8');
      return {
        success: true,
        data: { content, mode: 'text' },
        durationMs: Date.now() - start,
        truncated: false,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message ?? String(err),
        durationMs: Date.now() - start,
        truncated: false,
      };
    }
  }

  private validatePath(resolved: string): void {
    // Check if path is within any of the allowed directories
    const allowed = this.allowedDirectories.some((dir) => {
      const resolvedDir = path.resolve(dir);
      // Normalize both to handle trailing slashes, etc.
      const normalizedResolved = path.normalize(resolved);
      const normalizedDir = path.normalize(resolvedDir);
      // Must start with the allowed directory (and either be equal or have a separator after)
      return (
        normalizedResolved === normalizedDir ||
        normalizedResolved.startsWith(normalizedDir + path.sep)
      );
    });

    if (!allowed) {
      throw new Error(
        `Path traversal blocked: '${resolved}' is not within allowed directories`
      );
    }
  }
}
