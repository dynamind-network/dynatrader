import { promises as fs } from 'fs';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface WriteToolConfig {
  allowedDirectories?: string[];
  workspaceRoot?: string;
}

export class WriteTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'write',
    description: 'Write content to files on the filesystem',
    category: 'file',
    inputSchema: { path: 'string', content: 'string', mode: 'string?' },
    outputSchema: { path: 'string', bytesWritten: 'number' },
    permissionsRequired: ['tool.write'],
    sideEffects: ['modifies_filesystem'],
    riskLevel: 'medium',
    timeoutMs: 10000,
  };

  private allowedDirectories: readonly string[];
  private workspaceRoot: string;

  constructor(config?: WriteToolConfig) {
    this.allowedDirectories = config?.allowedDirectories ?? [process.cwd()];
    this.workspaceRoot = config?.workspaceRoot ?? this.allowedDirectories[0] ?? process.cwd();
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

      const content = call.args.content;
      if (typeof content !== 'string') {
        return {
          success: false,
          error: 'Content must be a string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const mode = (call.args.mode as string | undefined) ?? 'text';
      let resolved = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(this.workspaceRoot, filePath);
      if (!path.isAbsolute(filePath)) {
        for (const root of this.allowedDirectories) {
          const candidate = path.resolve(root, filePath);
          if (candidate === resolved) continue;
          try {
            if ((await fs.stat(candidate)).isFile()) { resolved = candidate; break; }
          } catch { /* New relative files still use the active project root. */ }
        }
      }
      this.validatePath(resolved);

      // Create parent directory if it doesn't exist
      await fs.mkdir(path.dirname(resolved), { recursive: true });

      let oldContent: string | undefined;
      try { oldContent = await fs.readFile(resolved, 'utf-8'); } catch { /* new file */ }

      if (mode === 'binary') {
        const buffer = Buffer.from(content, 'base64');
        await fs.writeFile(resolved, buffer);
        return {
          success: true,
          data: { path: resolved, bytesWritten: buffer.length },
          artifacts: { kind: 'write', path: resolved, contents: `[binary file: ${buffer.length} bytes]`, isNewFile: oldContent === undefined },
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      await fs.writeFile(resolved, content, 'utf-8');
      const encoder = new TextEncoder();
      const bytesWritten = encoder.encode(content).length;
      const preview = content.split('\n').slice(0, 300).join('\n').slice(0, 12_000);
      const previewTruncated = preview.length < content.length;

      return {
        success: true,
        data: { path: resolved, bytesWritten },
        artifacts: {
          kind: 'write', path: resolved,
          contents: preview,
          isNewFile: oldContent === undefined,
          isTruncated: previewTruncated,
        },
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
    const allowed = this.allowedDirectories.some((dir) => {
      const resolvedDir = path.resolve(dir);
      const normalizedResolved = path.normalize(resolved);
      const normalizedDir = path.normalize(resolvedDir);
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
