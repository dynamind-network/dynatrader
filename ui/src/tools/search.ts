import * as fs from "fs/promises";
import * as path from "path";
import { fdir } from "fdir";
import picomatch from "picomatch";
import { BaseTool, ToolKind } from "./base-tool.js";
import type { ToolExecutionContext, ToolResult } from "../core/types.js";
import { PathSecurity } from "./path-security.js";

/**
 * Glob - find files by pattern
 */
export class GlobTool extends BaseTool {
  name = "glob";
  description =
    'Find files by name or path pattern. Use this first when the user asks to locate files such as "find CommandInput", "where is the config", or "show all tsx files".';
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;
  searchHint = "search find text content regex code symbol function";
  kind = ToolKind.Search;

  inputSchema = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match (e.g., "**/*.ts", "src/**/*.js")',
      },
      path: {
        type: "string",
        description:
          "Directory to search in (optional, defaults to working directory)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 100)",
      },
      fileType: {
        type: "string",
        description:
          "Filter by file extension (e.g., 'ts', 'js', 'tsx'). Optional.",
      },
      includeHidden: {
        type: "boolean",
        description: "Include hidden files starting with '.' (default: false)",
      },
    },
    required: ["pattern"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || context.workingDirectory;
    const limit = (input.limit as number) || 100;
    const fileType = input.fileType as string | undefined;
    const includeHidden = (input.includeHidden as boolean) || false;

    let absolutePath: string;
    try {
      absolutePath = PathSecurity.resolveWithinWorkspace(
        searchPath,
        context.workingDirectory,
      );
    } catch (err) {
      return this.handleError(err, "Invalid search path");
    }

    try {
      const excludedDirs = includeHidden
        ? ["node_modules", ".git", ".dynamind", "dist", "build", ".cache"]
        : [
            "node_modules",
            ".git",
            ".dynamind",
            "dist",
            "build",
            ".cache",
            ".vscode",
            ".idea",
          ];

      const crawler = new fdir()
        .withFullPaths()
        .exclude((dirName) => excludedDirs.includes(dirName))
        .crawl(absolutePath);

      const allFiles = await crawler.withPromise();

      let filteredFiles = allFiles;

      if (fileType) {
        const ext = fileType.startsWith(".") ? fileType : `.${fileType}`;
        filteredFiles = filteredFiles.filter((file) =>
          file.toLowerCase().endsWith(ext.toLowerCase()),
        );
      }

      const matcher = picomatch(pattern, { dot: true, nocase: true });
      const matches = filteredFiles
        .filter((file) => {
          const relativePath = path.relative(absolutePath, file);
          return matcher(relativePath) || matcher(file);
        })
        .slice(0, limit);

      if (matches.length === 0) {
        return this.success(
          `No files found matching pattern: ${pattern}${fileType ? ` with extension: ${fileType}` : ""}`,
        );
      }

      const relativeMatches = matches.map((file) =>
        path.relative(context.workingDirectory, file),
      );

      const output = [
        `Found ${matches.length} file${matches.length !== 1 ? "s" : ""} matching "${pattern}":`,
        "",
        ...relativeMatches.map((f) => `  - ${f}`),
        matches.length >= limit ? `\n(Limited to ${limit} results)` : "",
      ].join("\n");

      const artifacts = {
        pattern,
        count: matches.length,
        files: relativeMatches,
        limited: matches.length >= limit,
      };

      return this.success(output, artifacts);
    } catch (err) {
      return this.handleError(err, "Glob search failed");
    }
  }
}

/**
 * Grep - search file contents
 */
export class GrepTool extends BaseTool {
  name = "grep";
  description =
    "Search file contents for text or regex matches. Use this first when the user asks to find a symbol, function, component, error string, or code snippet in the repo.";
  isDestructive = false;
  readOnly = true;
  canRunInParallel = true;
  searchHint = "search find text content regex code symbol function";
  kind = ToolKind.Search;

  inputSchema = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search in (optional)",
      },
      glob: {
        type: "string",
        description: 'Glob pattern to filter files (e.g., "*.ts")',
      },
      case_insensitive: {
        type: "boolean",
        description: "Case insensitive search (default: false)",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines before/after match (default: 0)",
      },
      limit: {
        type: "number",
        description: "Maximum number of matches (default: 50)",
      },
      showLineNumbers: {
        type: "boolean",
        description: "Show line numbers in output (default: true)",
      },
    },
    required: ["pattern"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || context.workingDirectory;
    const globPattern = input.glob as string | undefined;
    const caseInsensitive = (input.case_insensitive as boolean) || false;
    const contextLines = (input.context_lines as number) || 0;
    const limit = (input.limit as number) || 50;
    const showLineNumbers = input.showLineNumbers !== false;

    let absolutePath: string;
    try {
      absolutePath = PathSecurity.resolveWithinWorkspace(
        searchPath,
        context.workingDirectory,
      );
    } catch (err) {
      return this.handleError(err, "Invalid search path");
    }

    try {
      const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
      const results: string[] = [];
      let matchCount = 0;

      let files: string[] = [];
      const stats = await fs.stat(absolutePath);

      if (stats.isFile()) {
        files = [absolutePath];
      } else {
        const crawler = new fdir()
          .withFullPaths()
          .exclude((dirName) =>
            ["node_modules", ".git", ".dynamind", "dist", "build"].includes(
              dirName,
            ),
          )
          .crawl(absolutePath);

        files = await crawler.withPromise();

        if (globPattern) {
          const matcher = picomatch(globPattern, { dot: true });
          files = files.filter((file) => {
            const basename = path.basename(file);
            const relativePath = path.relative(absolutePath, file);
            return matcher(basename) || matcher(relativePath);
          });
        }
      }

      for (const file of files) {
        if (matchCount >= limit) break;

        try {
          const content = await fs.readFile(file, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (matchCount >= limit) break;

            if (regex.test(lines[i])) {
              matchCount++;
              const relativePath = path.relative(
                context.workingDirectory,
                file,
              );

              const startLine = Math.max(0, i - contextLines);
              const endLine = Math.min(lines.length - 1, i + contextLines);

              const contextBlock = lines
                .slice(startLine, endLine + 1)
                .map((line, idx) => {
                  const lineNum = startLine + idx + 1;
                  const marker = lineNum === i + 1 ? ">" : " ";
                  if (showLineNumbers) {
                    return `${marker}${String(lineNum).padStart(4)}| ${line}`;
                  }
                  return `${marker} ${line}`;
                })
                .join("\n");

              results.push(
                `${relativePath}${showLineNumbers ? `:${i + 1}` : ""}\n${contextBlock}`,
              );

              regex.lastIndex = 0;
            }
          }
        } catch {
          // Skip files that can't be read
        }
      }

      if (results.length === 0) {
        return this.success(`No matches found for pattern: ${pattern}`);
      }

      const output = [
        `Found ${matchCount} match${matchCount !== 1 ? "es" : ""} for "${pattern}":`,
        "",
        results.join("\n\n"),
        matchCount >= limit ? `\n(Limited to ${limit} results)` : "",
      ].join("\n");

      const artifacts = {
        pattern,
        matchCount,
        results: results.slice(0, 10),
        limited: matchCount >= limit,
      };

      return this.success(output, artifacts);
    } catch (err) {
      return this.handleError(err, "Grep search failed");
    }
  }
}
