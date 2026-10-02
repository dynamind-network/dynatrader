import * as fs from "fs/promises";
import * as path from "path";
import { BaseTool, ToolKind } from "./base-tool.js";
import type { ToolExecutionContext, ToolResult } from "../core/types.js";
import { PathSecurity } from "./path-security.js";

const MAX_DIFF_ARTIFACT_CHARS = 12000;

const truncateArtifactText = (
  text: string,
): { text: string; wasTruncated: boolean } => {
  if (text.length <= MAX_DIFF_ARTIFACT_CHARS) {
    return { text, wasTruncated: false };
  }

  return {
    text: `${text.slice(0, MAX_DIFF_ARTIFACT_CHARS)}\n... diff truncated ...`,
    wasTruncated: true,
  };
};

const createDiffArtifacts = (
  absolutePath: string,
  oldText: string,
  newText: string,
  isNewFile: boolean,
): Record<string, unknown> => {
  const truncatedOld = truncateArtifactText(oldText);
  const truncatedNew = truncateArtifactText(newText);

  return {
    kind: "diff",
    path: absolutePath,
    oldText: truncatedOld.text,
    newText: truncatedNew.text,
    isNewFile,
    isTruncated: truncatedOld.wasTruncated || truncatedNew.wasTruncated,
  };
};

const isBinaryContent = (content: string): boolean => {
  const nullByteIndex = content.indexOf("\0");
  if (nullByteIndex !== -1 && nullByteIndex < 1024) return true;

  const nonPrintableCount = content
    .slice(0, 8192)
    .split("")
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;

  return nonPrintableCount > content.slice(0, 8192).length * 0.1;
};

const checkFileExists = async (
  absolutePath: string,
): Promise<{ exists: boolean; content: string }> => {
  try {
    await fs.access(absolutePath);
    const content = await fs.readFile(absolutePath, "utf-8");
    return { exists: true, content };
  } catch {
    return { exists: false, content: "" };
  }
};

export class WriteFileTool extends BaseTool {
  name = "write";
  description = "Write (or overwrite) a file's contents.";
  isDestructive = true;
  requiresApproval = true;
  mutatesFiles = true;
  searchHint = "create generate output save new file content";
  kind = ToolKind.Write;

  inputSchema = {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description:
          "The path to the file to write (absolute or relative to working directory)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
      check: {
        type: "boolean",
        description:
          "If true, only check and report what would happen without writing (default: false)",
      },
      force: {
        type: "boolean",
        description:
          "If true, skip content similarity check and always write (default: false)",
      },
    },
    required: ["path", "content"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = input.path as string;
    const content = input.content as string;
    const check = (input.check as boolean) || false;
    const force = (input.force as boolean) || false;

    if (!content || content.trim().length === 0) {
      return this.error("Content cannot be empty");
    }

    if (isBinaryContent(content)) {
      return this.error(
        "Content appears to be binary. Use a different approach for binary files.",
      );
    }

    let absolutePath: string;
    try {
      absolutePath = PathSecurity.resolveWithinWorkspace(
        filePath,
        context.workingDirectory,
      );
    } catch (err) {
      return this.handleError(err, "Invalid path");
    }

    const protectedCheck = PathSecurity.isProtectedFile(
      filePath,
      context.workingDirectory,
    );
    if (protectedCheck.protected) {
      return this.error(`Protected file: ${protectedCheck.reason}`);
    }

    const { exists, content: previousContent } =
      await checkFileExists(absolutePath);

    if (exists && previousContent === content && !force) {
      return this.error(
        `Content is identical to existing file. Use force: true to overwrite anyway.`,
      );
    }

    if (check) {
      const lineCount = content.split("\n").length;
      const byteCount = Buffer.byteLength(content, "utf-8");
      const action = exists ? "Would update" : "Would create";

      return this.success(
        `${action}: ${absolutePath}\nLines: ${lineCount}, Bytes: ${byteCount}`,
        createDiffArtifacts(absolutePath, previousContent, content, !exists),
      );
    }

    try {
      const parentDir = path.dirname(absolutePath);
      await fs.mkdir(parentDir, { recursive: true });

      const action = exists ? "Updated" : "Created";
      await fs.writeFile(absolutePath, content, "utf-8");

      const lineCount = content.split("\n").length;
      const byteCount = Buffer.byteLength(content, "utf-8");

      return this.success(
        `${action} file: ${absolutePath}\nLines: ${lineCount}, Bytes: ${byteCount}`,
        createDiffArtifacts(absolutePath, previousContent, content, !exists),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        return this.error(`Permission denied: ${absolutePath}`);
      }
      return this.handleError(err, "Failed to write file");
    }
  }
}

export class EditFileTool extends BaseTool {
  name = "edit";
  description = "Perform exact string replacements in a file.";
  isDestructive = true;
  requiresApproval = true;
  mutatesFiles = true;
  searchHint = "modify update change replace fix refactor string";
  kind = ToolKind.Edit;

  inputSchema = {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact string to search for and replace",
      },
      new_string: {
        type: "string",
        description: "The string to replace it with",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false, only first)",
      },
    },
    required: ["path", "old_string", "new_string"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = input.path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    let absolutePath: string;
    try {
      absolutePath = PathSecurity.resolveWithinWorkspace(
        filePath,
        context.workingDirectory,
      );
    } catch (err) {
      return this.handleError(err, "Invalid path");
    }

    // Check for protected files
    const protectedCheck = PathSecurity.isProtectedFile(
      filePath,
      context.workingDirectory,
    );
    if (protectedCheck.protected) {
      return this.error(`Protected file: ${protectedCheck.reason}`);
    }

    try {
      const content = await fs.readFile(absolutePath, "utf-8");

      if (!content.includes(oldString)) {
        return this.error(
          `String not found in file: "${oldString.substring(0, 100)}${oldString.length > 100 ? "..." : ""}"`,
        );
      }

      const occurrences = content.split(oldString).length - 1;

      if (occurrences > 1 && !replaceAll) {
        return this.error(
          `Found ${occurrences} occurrences of the string. Use replace_all: true to replace all, or provide more context to make it unique.`,
        );
      }

      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await fs.writeFile(absolutePath, newContent, "utf-8");

      const replacedCount = replaceAll ? occurrences : 1;
      return this.success(
        `Edited file: ${absolutePath}\nReplaced ${replacedCount} occurrence(s)`,
        createDiffArtifacts(absolutePath, content, newContent, false),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return this.error(`File not found: ${absolutePath}`);
      }
      return this.handleError(err, "Failed to edit file");
    }
  }
}

