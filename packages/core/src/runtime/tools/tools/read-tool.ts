import { promises as fs } from 'fs';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface ReadToolConfig {
  allowedDirectories?: string[];
  workspaceRoot?: string;
  maxFileSize?: number;
}

const DEFAULT_READ_PAGE_CHARS = 8 * 1024;
const MAX_READ_FILE_SIZE = 64 * 1024 * 1024;

export class ReadTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'read',
    description: 'Read workspace files. Large files return an 8K-character page; continue with the returned offset. maxSize controls the file-size allowance, not the page length.',
    category: 'file',
    inputSchema: {
      path: 'string',
      mode: 'string?',
      maxSize: 'number?',
      offset: 'number?',
      limit: 'number?',
    },
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
    this.maxFileSize = config?.maxFileSize ?? 8 * 1024 * 1024; // 8MB default
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
      const requestedMaxSize = call.args.maxSize as number | undefined;
      const configuredMaxSize = Math.min(MAX_READ_FILE_SIZE, this.maxFileSize);
      const maxSize = typeof requestedMaxSize === 'number' && Number.isFinite(requestedMaxSize)
        ? Math.min(MAX_READ_FILE_SIZE, Math.max(0, requestedMaxSize))
        : configuredMaxSize;
      const requestedOffset = call.args.offset as number | undefined;
      const offset = typeof requestedOffset === 'number' && Number.isFinite(requestedOffset)
        ? Math.max(0, Math.floor(requestedOffset))
        : 0;
      const requestedLimit = call.args.limit as number | undefined;
      const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
        ? Math.min(DEFAULT_READ_PAGE_CHARS, Math.max(1, Math.floor(requestedLimit)))
        : DEFAULT_READ_PAGE_CHARS;

      const candidates = path.isAbsolute(filePath)
        ? [path.normalize(filePath)]
        : [...new Set([this.workspaceRoot, ...this.allowedDirectories].map((root) => path.resolve(root, filePath)))];
      let resolved: string | undefined;
      let stats: import('fs').Stats | undefined;
      for (const candidate of candidates) {
        this.validatePath(candidate);
        try {
          const candidateStats = await fs.stat(candidate);
          if (candidateStats.isFile()) {
            resolved = candidate;
            stats = candidateStats;
            break;
          }
        } catch { /* Try the next explicitly allowed root. */ }
      }
      if (!resolved || !stats) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
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

      const fullContent = await fs.readFile(resolved, 'utf-8');
      const content = fullContent.slice(offset, offset + limit);
      const nextOffset = offset + content.length;
      const pageInfo = nextOffset < fullContent.length
        ? `\n\n[Read characters ${offset}-${nextOffset} of ${fullContent.length}. Continue with offset=${nextOffset}.]`
        : `\n\n[Read characters ${offset}-${nextOffset} of ${fullContent.length}. End of file.]`;
      return {
        success: true,
        data: { content: content + pageInfo, mode: 'text', offset, nextOffset, totalChars: fullContent.length },
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
