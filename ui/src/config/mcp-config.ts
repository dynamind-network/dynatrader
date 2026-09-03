import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import type { MCPServerConfig } from '../core/types.js';
import { parseJson } from '../utils/json.js';
import {
  getDynamindPath,
  DYNAMIND_DIR,
  getHomeDirectory,
  isPlainObject,
} from '../utils/constants.js';

/**
 * Configuration for MCP servers that the terminal connects to
 * These are external tool providers (like Hyperliquid, Polymarket, etc.)
 */

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Allowed MCP server commands — only known-safe executables.
 * Blocks arbitrary command execution via MCP config injection.
 */
const ALLOWED_MCP_COMMANDS = new Set([
  'node',
  'npx',
  'bun',
  'python',
  'python3',
  'uv',
  'deno',
  // Common MCP server packages
  'npx',
]);

/**
 * Blocked command patterns — shell interpreters and dangerous executables.
 * These are NEVER allowed regardless of allowlist.
 */
const BLOCKED_MCP_PATTERNS = [
  /sh$/i,
  /bash$/i,
  /zsh$/i,
  /cmd$/i,
  /powershell$/i,
  /pwsh$/i,
  /curl$/i,
  /wget$/i,
  /rm$/i,
  /dd$/i,
  /format$/i,
  /sudo$/i,
];

/**
 * CRITICAL: Blocked argument flags that enable code execution.
 * Prevents MCP config from bypassing security via command-line flags.
 */
const BLOCKED_ARG_FLAGS = [
  '-e', '--eval',           // node/deno - execute code string
  '-r', '--require',        // node - preload module
  '-c',                     // python - execute code string
  '--eval',                 // python - execute code string
  '--exec',                 // python - execute code string
  '-C',                     // npx - change directory (potential path traversal)
  '--module',               // node - treat input as ES module
  '--input-type',           // node - specify input type
  '--experimental-strip-types', // node - strip types (can bypass type checks)
];

/**
 * CRITICAL: Validate MCP args for dangerous flags that enable code execution.
 * Blocks flags that could be used to run arbitrary code.
 */
function validateMCPArgs(args: string[], command: string, filePath: string, serverName: string): void {
  const basename = path.basename(command).toLowerCase();

  for (const arg of args) {
    // Check for blocked flags
    if (BLOCKED_ARG_FLAGS.includes(arg)) {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${serverName}" uses blocked argument "${arg}". ` +
          `This flag enables arbitrary code execution and is not allowed for security reasons.`
      );
    }

    // For node/deno: block -e with following argument (code string)
    if ((basename === 'node' || basename === 'deno') && (arg === '-e' || arg === '--eval')) {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${serverName}" uses code execution flag. ` +
          `Node/Deno -e/--eval is not allowed for security reasons.`
      );
    }

    // For python: block -c with following argument (code string)
    if ((basename === 'python' || basename === 'python3') && arg === '-c') {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${serverName}" uses code execution flag. ` +
          `Python -c is not allowed for security reasons.`
      );
    }

    // Block shell metacharacters in args (command injection)
    if (/[;&|`$(){}!]/.test(arg)) {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${serverName}" has suspicious argument "${arg}". ` +
          `Shell metacharacters are not allowed in MCP arguments.`
      );
    }
  }
}

function isMCPCommandAllowed(command: string): boolean {
  const basename = path.basename(command).toLowerCase();

  // Block shell interpreters and dangerous commands
  for (const pattern of BLOCKED_MCP_PATTERNS) {
    if (pattern.test(basename)) {
      return false;
    }
  }

  // Allow if basename is in the allowlist
  if (ALLOWED_MCP_COMMANDS.has(basename)) {
    return true;
  }

  // Allow absolute paths to executables that exist on disk (user-installed MCPs)
  // But only if they're not shell interpreters
  return false;
}

/**
 * Default MCP servers configuration.
 * Users can add their own servers to ~/.dynamind/mcp.json or <workspace>/.dynamind/mcp.json.
 */
export const defaultMCPServers: Record<string, MCPServerConfig> = {
  // Hyperliquid - if you have the MCP server installed
  // hyperliquid: {
  //   command: 'node',
  //   args: ['path/to/hyperliquid-mcp/index.js'],
  //   env: {
  //     API_KEY: process.env.HYPERLIQUID_API_KEY || '',
  //     API_SECRET: process.env.HYPERLIQUID_API_SECRET || '',
  //   },
  // },
};

/**
 * Load MCP configuration from files.
 * Priority: defaults < user (~/.dynamind/mcp.json) < project (<workspace>/.dynamind/mcp.json)
 */
export async function loadMCPConfig(projectDir: string): Promise<Record<string, MCPServerConfig>> {
  let config: Record<string, MCPServerConfig> = { ...defaultMCPServers };

  const userPath = getDynamindPath('mcp.json');
  config = await mergeConfigFromFile(config, userPath);

  const projectPath = path.join(projectDir, DYNAMIND_DIR, 'mcp.json');
  config = await mergeConfigFromFile(config, projectPath);

  return config;
}

function looksLikePath(command: string): boolean {
  return (
    path.isAbsolute(command) ||
    command.startsWith('.') ||
    command.includes('/') ||
    command.includes('\\')
  );
}

function validateServerConfig(
  name: string,
  serverConfig: unknown,
  filePath: string
): MCPServerConfig {
  if (!isPlainObject(serverConfig)) {
    throw new Error(`Invalid MCP config in ${filePath}: server "${name}" must be an object.`);
  }

  const command = serverConfig.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(
      `Invalid MCP config in ${filePath}: server "${name}" must define a non-empty "command" string.`
    );
  }

  const args = serverConfig.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    throw new Error(
      `Invalid MCP config in ${filePath}: server "${name}" must define "args" as an array of strings.`
    );
  }

  const env = serverConfig.env;
  if (env !== undefined) {
    if (!isPlainObject(env)) {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${name}" must define "env" as an object of string values.`
      );
    }

    for (const [envName, envValue] of Object.entries(env)) {
      if (typeof envValue !== 'string') {
        throw new Error(
          `Invalid MCP config in ${filePath}: server "${name}" has a non-string env value for "${envName}".`
        );
      }
    }
  }

  if (looksLikePath(command)) {
    const resolvedCommand = path.isAbsolute(command)
      ? command
      : path.resolve(path.dirname(filePath), command);
    if (!nodeFs.existsSync(resolvedCommand)) {
      throw new Error(
        `Invalid MCP config in ${filePath}: server "${name}" references command "${command}" but ${resolvedCommand} does not exist.`
      );
    }
  }

  // CRITICAL: Validate command against allowlist to prevent MCP config injection
  if (!isMCPCommandAllowed(command)) {
    throw new Error(
      `Invalid MCP config in ${filePath}: server "${name}" uses command "${command}" which is not in the allowed list. ` +
        `Allowed commands: ${[...ALLOWED_MCP_COMMANDS].join(', ')}. ` +
        `This prevents command injection through MCP configuration files.`
    );
  }

  // CRITICAL: Validate args for dangerous flags that enable code execution
  if (Array.isArray(args) && args.length > 0) {
    validateMCPArgs(args, command, filePath, name);
  }

  // CRITICAL: Block dangerous environment variables that could hijack module loading
  if (env && typeof env === 'object') {
    const DANGEROUS_ENV_VARS = [
      'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
      'PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONSTARTUP',
    ];
    for (const envName of Object.keys(env)) {
      if (DANGEROUS_ENV_VARS.includes(envName)) {
        throw new Error(
          `Invalid MCP config in ${filePath}: server "${name}" sets dangerous environment variable "${envName}". ` +
            `This variable could hijack module loading or binary resolution.`
        );
      }
    }
  }

  return {
    command,
    args: Array.isArray(args) ? [...args] : [],
    env: env as Record<string, string> | undefined,
  };
}

async function mergeConfigFromFile(
  base: Record<string, MCPServerConfig>,
  filePath: string
): Promise<Record<string, MCPServerConfig>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseJson<unknown>(content);
    if (parsed === undefined) {
      throw new Error(`Invalid JSON in ${filePath}`);
    }

    if (!isPlainObject(parsed)) {
      throw new Error(`Invalid MCP config in ${filePath}: expected a JSON object.`);
    }

    if (!isPlainObject(parsed.mcpServers)) {
      throw new Error(`Invalid MCP config in ${filePath}: expected {"mcpServers": {...}}.`);
    }

    const servers: Record<string, MCPServerConfig> = {};
    for (const [name, serverConfig] of Object.entries(parsed.mcpServers)) {
      servers[name] = validateServerConfig(name, serverConfig, filePath);
    }

    return { ...base, ...servers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return base;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
    }

    if (error instanceof Error) {
      throw error;
    }
  }

  return base;
}

/**
 * Save MCP configuration to project directory
 */
export async function saveMCPConfig(
  projectDir: string,
  servers: Record<string, MCPServerConfig>
): Promise<void> {
  const configPath = path.join(projectDir, DYNAMIND_DIR, 'mcp.json');
  const configDir = path.dirname(configPath);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2));
}

/**
 * Example MCP configuration file content
 */
export const exampleMCPConfig = `{
  "mcpServers": {
    "hyperliquid": {
      "command": "node",
      "args": ["./hyperliquid-mcp/index.js"],
      "env": {
        "API_KEY": "your-api-key",
        "API_SECRET": "your-api-secret"
      }
    },
    "polymarket": {
      "command": "npx",
      "args": ["-y", "@anthropic/polymarket-mcp"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }
}`;
