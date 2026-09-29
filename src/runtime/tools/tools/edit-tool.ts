import { promises as fs } from 'fs';
import path from 'path';
import type { ToolCall, ToolResult, ToolHandler, ToolDefinition } from '@dyna/contracts';

export interface EditToolConfig {
  allowedDirectories?: string[];
  workspaceRoot?: string;
}

export class EditTool implements ToolHandler {
  readonly definition: ToolDefinition = {
    name: 'edit',
    description: 'Perform exact string replacements in files',
    category: 'file',
    inputSchema: {
      filePath: 'string',
      oldString: 'string',
      newString: 'string',
      replaceAll: 'boolean?',
    },
    outputSchema: { replacements: 'number', filePath: 'string' },
    permissionsRequired: ['tool.write'],
    sideEffects: ['modifies_filesystem'],
    riskLevel: 'medium',
    timeoutMs: 10000,
  };

  private allowedDirectories: readonly string[];
  private workspaceRoot: string;

  constructor(config?: EditToolConfig) {
    this.allowedDirectories = config?.allowedDirectories ?? [process.cwd()];
    this.workspaceRoot = config?.workspaceRoot ?? this.allowedDirectories[0] ?? process.cwd();
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const filePath = call.args.filePath;
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return {
          success: false,
          error: 'filePath must be a non-empty string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const oldString = call.args.oldString;
      if (typeof oldString !== 'string') {
        return {
          success: false,
          error: 'oldString must be a string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const newString = call.args.newString;
      if (typeof newString !== 'string') {
        return {
          success: false,
          error: 'newString must be a string',
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const replaceAll = (call.args.replaceAll as boolean | undefined) ?? false;

      const resolved = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(this.workspaceRoot, filePath);
      this.validatePath(resolved);

      let content: string;
      try {
        content = await fs.readFile(resolved, 'utf-8');
      } catch {
        return {
          success: false,
          error: `File not found: ${filePath}`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (oldString === newString) {
        return {
          success: true,
          data: { replacements: 0, filePath: resolved },
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      // Count occurrences
      let occurrences = 0;
      let pos = -1;
      while ((pos = content.indexOf(oldString, pos + 1)) !== -1) {
        occurrences++;
      }

      if (occurrences === 0) {
        return {
          success: false,
          error: `oldString not found in file content`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      if (occurrences > 1 && !replaceAll) {
        return {
          success: false,
          error: `Found ${occurrences} matches for oldString. Provide more surrounding context in oldString or use replaceAll: true`,
          durationMs: Date.now() - start,
          truncated: false,
        };
      }

      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      const oldPreview = content.split('\n').slice(0, 300).join('\n').slice(0, 12_000);
      const newPreview = newContent.split('\n').slice(0, 300).join('\n').slice(0, 12_000);

      await fs.writeFile(resolved, newContent, 'utf-8');

      return {
        success: true,
        data: { replacements: occurrences, filePath: resolved },
        artifacts: {
          kind: 'diff', path: resolved,
          oldText: oldPreview, newText: newPreview,
          isTruncated: oldPreview.length < content.length || newPreview.length < newContent.length,
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
