/**
 * Base utilities for file operation tools to share common logic
 */

import * as path from "path";
import * as fs from "fs/promises";
import { PathSecurity } from "./path-security.js";

export interface FileError {
  code: string;
  message: string;
}

export class FileOperationsBase {
  /**
   * Resolve a file path (absolute or relative) to absolute path
   * Validates that the resolved path stays within the working directory to prevent path traversal
   */
  protected resolveAbsolutePath(
    filePath: string,
    workingDirectory: string,
  ): string {
    return PathSecurity.resolveWithinWorkspace(filePath, workingDirectory);
  }

  /**
   * Handle file operation errors and return standardized error message
   */
  protected handleFileError(
    err: unknown,
    operation: string,
    filePath: string,
  ): FileError {
    const nodeErr = err as NodeJS.ErrnoException;

    switch (nodeErr.code) {
      case "ENOENT":
        return {
          code: "ENOENT",
          message: `File not found: ${filePath}`,
        };
      case "EACCES":
        return {
          code: "EACCES",
          message: `Permission denied: ${filePath}`,
        };
      case "EISDIR":
        return {
          code: "EISDIR",
          message: `Is a directory, not a file: ${filePath}`,
        };
      case "ENOSPC":
        return {
          code: "ENOSPC",
          message: `No space left on device`,
        };
      default:
        return {
          code: nodeErr.code || "UNKNOWN",
          message: `${operation} failed for ${filePath}: ${nodeErr.message}`,
        };
    }
  }

  /**
   * Format file content with line numbers (like cat -n)
   */
  protected formatWithLineNumbers(
    content: string,
    startLine = 1,
    maxLineLength = 2000,
  ): string {
    const lines = content.split("\n");
    const endLine = Math.min(startLine + lines.length - 1, lines.length);

    const numberedLines = lines.map((line, idx) => {
      const lineNum = startLine + idx;
      const truncatedLine =
        line.length > maxLineLength
          ? line.substring(0, maxLineLength) + "..."
          : line;
      return `${String(lineNum).padStart(6)}  ${truncatedLine}`;
    });

    return numberedLines.join("\n");
  }

  /**
   * Check if path is a directory
   */
  protected async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Check if file exists
   */
  protected async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file size in bytes
   */
  protected async getFileSize(filePath: string): Promise<number | null> {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch {
      return null;
    }
  }

  /**
   * Apply offset and limit to lines
   */
  protected sliceLines(
    lines: string[],
    offset: number,
    limit: number,
  ): {
    selected: string[];
    startLine: number;
    endLine: number;
    totalLines: number;
  } {
    const startLine = Math.max(1, offset) - 1;
    const endLine = Math.min(startLine + limit, lines.length);
    const selected = lines.slice(startLine, endLine);

    return {
      selected,
      startLine: startLine + 1,
      endLine,
      totalLines: lines.length,
    };
  }
}

