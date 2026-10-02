import * as path from "path";
import * as fs from "fs";
import { getErrorMessage } from "../utils/index.js";

/**
 * Path security utilities to prevent path traversal attacks
 * Comprehensive protection against path traversal, URL encoding, backslash injection, null bytes, and Unicode bypasses
 */

export class PathSecurity {
  /**
   * List of protected file basenames that should not be modified
   * These files contain sensitive configuration, secrets, or critical project metadata
   */
  private static PROTECTED_BASENAMES = new Set([
    ".env",
    ".gitconfig",
    ".bashrc",
    ".zshrc",
    ".profile",
    "mcp.json",
    "claude.json",
    "package.json",
    "tsconfig.json",
    ".npmrc",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
  ]);

  /**
   * Check if a file path points to a protected file
   * @returns {protected: true, reason: string} if protected, {protected: false} otherwise
   */
  static isProtectedFile(
    filePath: string,
    workingDirectory: string,
  ): { protected: boolean; reason?: string } {
    try {
      const absolutePath = this.resolveWithinWorkspace(
        filePath,
        workingDirectory,
      );
      const basename = path.basename(absolutePath);

      // Check exact basename matches
      if (this.PROTECTED_BASENAMES.has(basename)) {
        return {
          protected: true,
          reason: `File '${basename}' is protected from modification`,
        };
      }

      // Protect any .env.* files (e.g., .env.local, .env.production)
      if (basename.startsWith(".env")) {
        return {
          protected: true,
          reason: `Environment file '${basename}' is protected`,
        };
      }

      return { protected: false };
    } catch {
      // If path resolution fails, don't block here (error will be handled elsewhere)
      return { protected: false };
    }
  }

  /**
   * Resolve a file path (absolute or relative) to absolute path
   * Validates that the resolved path stays within the working directory to prevent path traversal
   * @throws Error if path would escape the working directory boundary
   */
  static resolveWithinWorkspace(
    filePath: string,
    workingDirectory: string,
  ): string {
    const sanitized = this.sanitizePath(filePath);
    const absolutePath = path.isAbsolute(sanitized)
      ? sanitized
      : path.join(workingDirectory, sanitized);

    const normalizedPath = path.normalize(absolutePath);
    const normalizedWorkingDir = path.normalize(workingDirectory).toLowerCase();

    // Case-insensitive comparison
    const normalizedPathLower = normalizedPath.toLowerCase();

    if (
      !normalizedPathLower.startsWith(normalizedWorkingDir + path.sep) &&
      normalizedPathLower !== normalizedWorkingDir
    ) {
      throw new Error(
        `Path traversal detected: ${filePath} resolves outside workspace boundary`,
      );
    }

    return normalizedPath;
  }

  /**
   * Comprehensive path sanitization to neutralize attack vectors
   */
  private static sanitizePath(filePath: string): string {
    let sanitized = filePath;

    // 1. Normalize Unicode (NFKC form) to prevent homoglyph attacks
    try {
      sanitized = sanitized.normalize("NFKC");
    } catch {
      // ignore normalization errors
    }

    // 2. Decode URL encoding (handle double, triple, etc.)
    let decodeAttempts = 0;
    const maxDecodeAttempts = 10;
    while (decodeAttempts < maxDecodeAttempts) {
      try {
        const decoded = decodeURIComponent(sanitized);
        if (decoded === sanitized) break;
        sanitized = decoded;
      } catch {
        break;
      }
      decodeAttempts++;
    }

    // 3. Normalize path separators (backslash to forward slash)
    sanitized = sanitized.replace(/\\/g, "/");

    // 4. Collapse multiple consecutive slashes
    sanitized = sanitized.replace(/\/+/g, "/");

    // 5. Remove null bytes (can be used to truncate path checks)
    sanitized = sanitized.replace(/\0/g, "");

    // 6. Remove trailing slashes (except root)
    if (sanitized.length > 1 && sanitized.endsWith("/")) {
      sanitized = sanitized.slice(0, -1);
    }

    return sanitized;
  }

  /**
   * Check if a path is within the workspace boundary
   */
  static isWithinWorkspace(
    filePath: string,
    workingDirectory: string,
  ): boolean {
    try {
      this.resolveWithinWorkspace(filePath, workingDirectory);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate that a path exists and is accessible
   */
  static validatePathAccess(filePath: string): {
    valid: boolean;
    error?: string;
  } {
    try {
      const stats = fs.statSync(filePath);
      if (stats.isDirectory() && !stats.mode) {
        return { valid: false, error: "Directory has no read permissions" };
      }
      return { valid: true };
    } catch (err) {
      const message = getErrorMessage(err);
      if (message.includes("ENOENT")) {
        return { valid: false, error: "Path does not exist" };
      }
      if (message.includes("EACCES")) {
        return { valid: false, error: "Access denied" };
      }
      return { valid: false, error: message };
    }
  }

  /**
   * Get safe relative path for display
   */
  static getDisplayPath(filePath: string, workingDirectory: string): string {
    try {
      const resolved = this.resolveWithinWorkspace(filePath, workingDirectory);
      const relative = path.relative(workingDirectory, resolved);
      return relative || ".";
    } catch {
      return "[external]";
    }
  }
}

