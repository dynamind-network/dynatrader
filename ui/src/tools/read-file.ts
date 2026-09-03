import * as fs from 'fs/promises';
import * as path from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { BaseTool, ToolKind } from './base-tool.js';
import type { ToolExecutionContext, ToolResult } from '../core/types.js';
import { PathSecurity } from './path-security.js';

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = '... (line truncated)';
const MAX_BYTES = 256 * 1024;
const MAX_BYTES_LABEL = '256 KB';
const MAX_TOKENS = 25000;

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

const isBlockedDevicePath = (filePath: string): boolean => {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  if (BLOCKED_DEVICE_PATHS.has(normalized)) return true;
  if (
    normalized.startsWith('/proc/') &&
    (normalized.endsWith('/fd/0') || normalized.endsWith('/fd/1') || normalized.endsWith('/fd/2'))
  )
    return true;
  return false;
};

const CODE_SUMMARY_PATTERNS: Record<
  string,
  { imports: RegExp; functions: RegExp; classes: RegExp; exports: RegExp }
> = {
  '.ts': {
    imports: /import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    functions:
      /(?:function\s+(\w+)|(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*(?:=>|=|:)|(\w+)\s*=>)/g,
    classes: /class\s+(\w+)/g,
    exports: /export\s+(?:default\s+)?(?:class|function|const|interface|type)\s+(\w+)/g,
  },
  '.tsx': {
    imports: /import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    functions:
      /(?:function\s+(\w+)|(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*(?:=>|=|:)|(\w+)\s*=>)/g,
    classes: /class\s+(\w+)/g,
    exports: /export\s+(?:default\s+)?(?:function|const|interface|type|class)\s+(\w+)/g,
  },
  '.js': {
    imports: /import\s+(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    functions: /(?:function\s+(\w+)|(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*=>)/g,
    classes: /class\s+(\w+)/g,
    exports: /export\s+(?:default\s+)?(?:function|const|class)\s+(\w+)/g,
  },
  '.jsx': {
    imports: /import\s+(?:\{[^}]*\}|\w+)\s+from\s+['"]([^'"]+)['"]/g,
    functions: /(?:function\s+(\w+)|(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s+)?\(|(\w+)\s*=>)/g,
    classes: /class\s+(\w+)/g,
    exports: /export\s+(?:default\s+)?(?:function|const|class)\s+(\w+)/g,
  },
  '.py': {
    imports: /(?:from\s+(\S+)\s+import|import\s+(\S+))/g,
    functions: /def\s+(\w+)\s*\(/g,
    classes: /class\s+(\w+)/g,
    exports: /(?:^|\n)\s*(?:def|class)\s+(\w+)/g,
  },
  '.go': {
    imports: /import\s+(?:"([^"]+)"|\(([^)]+)\))/g,
    functions: /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g,
    classes: /type\s+(\w+)\s+struct/g,
    exports: /func\s+(\w+)\s*\(/g,
  },
  '.rs': {
    imports: /use\s+([^;]+)/g,
    functions: /fn\s+(\w+)\s*[<(]/g,
    classes: /struct\s+(\w+)|enum\s+(\w+)/g,
    exports: /pub\s+(?:fn|struct|enum|mod)\s+(\w+)/g,
  },
  '.java': {
    imports: /import\s+([^;]+)/g,
    functions: /(?:public|private|protected)?\s*(?:static)?\s*(?:\w+)\s+(\w+)\s*\(/g,
    classes: /(?:public|class|interface)\s+(\w+)/g,
    exports: /(?:public|private)\s+(?:static\s+)?(?:\w+)\s+(\w+)\s*[<(]/g,
  },
  '.rb': {
    imports: /require\s+['"]([^'"]+)['"]/g,
    functions: /def\s+(\w+)/g,
    classes: /class\s+(\w+)/g,
    exports: /def\s+(\w+)/g,
  },
  '.sql': {
    imports: /(?:)/g,
    functions: /CREATE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)/gi,
    classes: /(?:)/g,
    exports: /CREATE\s+(?:TABLE|VIEW|PROCEDURE|FUNCTION)\s+(\w+)/gi,
  },
  '.json': {
    imports: /(?:)/g,
    functions: /(?:)/g,
    classes: /(?:)/g,
    exports: /"(\w+)":/g,
  },
  '.md': {
    imports: /(?:)/g,
    functions: /(?:)/g,
    classes: /(?:)/g,
    exports: /^##\s+(.+)$/gm,
  },
  '.sh': {
    imports: /source\s+([^\s]+)/g,
    functions: /function\s+(\w+)|(\w+)\s*\(\)/g,
    classes: /(?:)/g,
    exports: /(?:)/g,
  },
};

interface CodeAnalysis {
  imports: string[];
  functions: string[];
  classes: string[];
  exports: string[];
}

const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.class',
  '.jar',
  '.war',
  '.7z',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.bin',
  '.dat',
  '.obj',
  '.o',
  '.a',
  '.lib',
  '.wasm',
  '.pyc',
  '.pyo',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.pdf',
]);

const IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
]);

const isBinaryExtension = (filepath: string): boolean => {
  const ext = path.extname(filepath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
};

const getMimeType = (filepath: string): string => {
  const ext = path.extname(filepath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.md': 'text/markdown',
    '.py': 'text/python',
    '.rb': 'text/ruby',
    '.java': 'text/java',
    '.c': 'text/c',
    '.cpp': 'text/cpp',
    '.h': 'text/c-header',
    '.go': 'text/go',
    '.rs': 'text/rust',
    '.sh': 'text/x-sh',
    '.bash': 'text/x-sh',
    '.ps1': 'text/x-powershell',
    '.sql': 'text/sql',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
  };
  return mimeTypes[ext] || 'application/octet-stream';
};

const isBinaryContent = async (filepath: string, fileSize: number): Promise<boolean> => {
  if (fileSize === 0) return false;

  const fh = await fs.open(filepath, 'r');
  try {
    const sampleSize = Math.min(4096, fileSize);
    const buf = Buffer.alloc(sampleSize);
    const result = await fh.read(buf, 0, sampleSize, 0);
    if (result.bytesRead === 0) return false;

    let nullCount = 0;
    let nonPrintableCount = 0;

    for (let i = 0; i < result.bytesRead; i++) {
      if (buf[i] === 0) nullCount++;
      if (buf[i] < 9 || (buf[i] > 13 && buf[i] < 32)) {
        nonPrintableCount++;
      }
    }

    if (nullCount > 0) return true;
    return nonPrintableCount / result.bytesRead > 0.3;
  } finally {
    await fh.close();
  }
};

const analyzeCode = (content: string, ext: string): CodeAnalysis => {
  const patterns = CODE_SUMMARY_PATTERNS[ext] || CODE_SUMMARY_PATTERNS['.ts'];
  const imports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];
  const exports: string[] = [];

  const importMatches = content.matchAll(patterns.imports);
  for (const match of importMatches) {
    if (match[1]) imports.push(match[1]);
  }

  const functionMatches = content.matchAll(patterns.functions);
  for (const match of functionMatches) {
    for (let i = 1; i < match.length; i++) {
      if (match[i] && !functions.includes(match[i])) {
        functions.push(match[i]);
      }
    }
  }

  const classMatches = content.matchAll(patterns.classes);
  for (const match of classMatches) {
    if (match[1]) classes.push(match[1]);
  }

  const exportMatches = content.matchAll(patterns.exports);
  for (const match of exportMatches) {
    if (match[1]) exports.push(match[1]);
  }

  return { imports, functions, classes, exports };
};

const readFileStream = async (
  filepath: string,
  offset: number,
  limit: number
): Promise<{
  lines: string[];
  totalLines: number;
  truncated: boolean;
  truncatedByBytes: boolean;
}> => {
  const stream = createReadStream(filepath, { encoding: 'utf8' });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const raw: string[] = [];
  let bytes = 0;
  let lines = 0;
  let truncated = false;
  let truncatedByBytes = false;

  try {
    for await (const text of rl) {
      lines++;
      if (lines < offset) continue;

      if (raw.length >= limit) {
        truncated = true;
        continue;
      }

      const line =
        text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text;
      const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0);

      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        truncated = true;
        break;
      }

      raw.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    lines: raw,
    totalLines: lines,
    truncated,
    truncatedByBytes,
  };
};

export class ReadFileTool extends BaseTool {
  name = 'read';
  description =
    'Read a file or directory. File output includes line numbers, and directory output is indexed for easy navigation.';
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;
  searchHint = 'examine inspect view file contents directory structure code';
  kind = ToolKind.Read;

  inputSchema = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read (absolute or relative to working directory)',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed). Optional.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read. Optional, defaults to 2000.',
      },
      analyze: {
        type: 'boolean',
        description:
          'Enable code analysis to extract imports, functions, classes, and exports. Optional.',
      },
      showModified: {
        type: 'boolean',
        description: 'Show file modification time in output. Optional, defaults to false.',
      },
    },
    required: ['path'],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const filePath = input.path as string;
    const offset = (input.offset as number) || 1;
    const limit = (input.limit as number) || DEFAULT_READ_LIMIT;
    const analyze = (input.analyze as boolean) || false;
    const showModified = (input.showModified as boolean) || false;

    if (offset < 1) {
      return this.error('offset must be >= 1');
    }

    if (isBlockedDevicePath(filePath)) {
      return this.error('Cannot read device path. This path is blocked for security reasons.');
    }

    let absolutePath: string;
    try {
      absolutePath = PathSecurity.resolveWithinWorkspace(filePath, context.workingDirectory);
    } catch (err) {
      return this.handleError(err, 'Invalid path');
    }

    try {
      const stats = await fs.stat(absolutePath);

      if (stats.isDirectory()) {
        return this.readDirectory(absolutePath, offset, limit);
      }

      const mimeType = getMimeType(absolutePath);
      const isImage = IMAGE_MIMETYPES.has(mimeType);
      const isPdf = mimeType === 'application/pdf';

      if (isImage || isPdf) {
        return this.readAsAttachment(absolutePath, mimeType);
      }

      if (isBinaryExtension(absolutePath)) {
        return this.error(
          `Binary file detected (${mimeType}). Use a different tool to handle this file type.`
        );
      }

      const isBinary = await isBinaryContent(absolutePath, stats.size);
      if (isBinary) {
        return this.error(
          `Cannot read binary file: ${absolutePath}. File appears to contain binary data.`
        );
      }

      const { lines, totalLines, truncated, truncatedByBytes } = await readFileStream(
        absolutePath,
        offset,
        limit
      );

      if (lines.length === 0 && totalLines === 0) {
        return this.error(`Empty file: ${absolutePath}`);
      }

      if (offset > totalLines && !(offset === 1 && totalLines === 0)) {
        return this.error(`Offset ${offset} is out of range for this file (${totalLines} lines)`);
      }

      const ext = path.extname(absolutePath).toLowerCase();
      const analysis = analyze ? analyzeCode(lines.join('\n'), ext) : null;

      const numberedLines = lines.map((line, idx) => {
        const lineNum = offset + idx;
        return `${String(lineNum).padStart(6)}  ${line}`;
      });

      const content = numberedLines.join('\n');
      const lastReadLine = offset + lines.length - 1;
      const nextOffset = lastReadLine + 1;
      const fileSizeKB = Math.round(stats.size / 1024);

      const relativePath = path.relative(context.workingDirectory, absolutePath);

      const output = [
        `[${relativePath}]`,
        '',
        `<type>file</type>`,
        `<mime>${mimeType}</mime>`,
        `<size>${fileSizeKB} KB</size>`,
      ];

      if (showModified) {
        const modified = stats.mtime.toISOString();
        output.push(`<modified>${modified}</modified>`);
      }

      if (
        analysis &&
        (analysis.functions.length > 0 ||
          analysis.classes.length > 0 ||
          analysis.imports.length > 0)
      ) {
        output.push('');
        if (analysis.classes.length > 0) {
          output.push(`Classes: ${analysis.classes.join(', ')}`);
        }
        if (analysis.functions.length > 0) {
          output.push(
            `Functions: ${analysis.functions.slice(0, 10).join(', ')}${analysis.functions.length > 10 ? ` (+${analysis.functions.length - 10} more)` : ''}`
          );
        }
        if (analysis.imports.length > 0) {
          output.push(
            `Imports: ${analysis.imports.slice(0, 5).join(', ')}${analysis.imports.length > 5 ? ` (+${analysis.imports.length - 5} more)` : ''}`
          );
        }
        if (analysis.exports.length > 0) {
          output.push(`Exports: ${analysis.exports.join(', ')}`);
        }
      }

      output.push('', '```', content);

      if (truncatedByBytes) {
        output.push(
          `\n\n[OUTPUT TRUNCATED] Capped at 512KB. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.`
        );
      } else if (truncated) {
        output.push(
          `\n\n[OUTPUT TRUNCATED] Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.`
        );
      } else {
        output.push(`\n\n[END OF FILE] Total ${totalLines} lines, ${fileSizeKB} KB`);
      }

      return this.success(output.join('\n'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.error(`File not found: ${absolutePath}`);
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        return this.error(`Permission denied: ${absolutePath}`);
      }
      return this.handleError(err, 'Failed to read file');
    }
  }

  private async readDirectory(
    absolutePath: string,
    offset: number,
    limit: number
  ): Promise<ToolResult> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        if (dirent.isDirectory()) return dirent.name + '/';
        if (dirent.isSymbolicLink()) {
          const target = await fs.stat(path.join(absolutePath, dirent.name)).catch(() => undefined);
          if (target?.isDirectory()) return dirent.name + '/';
        }
        return dirent.name;
      })
    );

    entries.sort((a, b) => a.localeCompare(b));

    const start = offset - 1;
    const sliced = entries.slice(start, start + limit);
    const hasMore = start + sliced.length < entries.length;
    const numberedEntries = sliced.map(
      (entry, index) => `${String(start + index + 1).padStart(6)}  ${entry}`
    );

    const output = [
      `<path>${absolutePath}</path>`,
      `<type>directory</type>`,
      '<entries>',
      numberedEntries.join('\n'),
      hasMore
        ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use offset to read more.)`
        : `\n(${entries.length} entries)`,
      '</entries>',
    ].join('\n');

    return this.success(output);
  }

  private async readAsAttachment(absolutePath: string, mimeType: string): Promise<ToolResult> {
    const buffer = await fs.readFile(absolutePath);
    const base64 = buffer.toString('base64');
    const fileName = path.basename(absolutePath);
    const type = mimeType.startsWith('image/') ? 'image' : 'pdf';

    return this.success(`[${type.toUpperCase()}] ${fileName} (${mimeType})`, {
      kind: type,
      path: absolutePath,
      mimeType,
      fileName,
      data: `data:${mimeType};base64,${base64}`,
    });
  }
}
