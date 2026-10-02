import * as fs from 'fs/promises';
import path from 'path';
import {
  DYNAMIND_DIR,
  deepMerge,
  getDynamindPath,
  getHomeDirectory,
  isPlainObject,
} from '../utils/constants.js';
import { parseJson } from '../utils/json.js';
import { reportSensitiveFilePermissions } from './sensitive-file-permissions.js';

const MAX_CONFIG_SIZE = 1024 * 1024;

export interface AppConfig {
  provider?: Record<
    string,
    {
      options?: {
        apiKey?: string;
        baseURL?: string;
      };
    }
  >;
  providers?: Partial<import('./providers.js').Providers>;
  market?: {
    symbols?: string[];
  };
  terminal?: {
    maxTurns?: number;
  };
  strategyEngines?: Record<string, string>;
  lastModel?: string;
}

async function ensureConfigDir(): Promise<void> {
  const configDir = getDynamindPath();
  try {
    await fs.mkdir(configDir, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function readConfigFile(filePath: string): Promise<Partial<AppConfig>> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CONFIG_SIZE) {
      console.warn(`[config] Skipping ${filePath}: ${stat.size} bytes exceeds 1MB limit`);
      return {};
    }
    const content = await fs.readFile(filePath, 'utf-8');
    reportSensitiveFilePermissions(filePath, stat.mode);
    const parsed = parseJson<unknown>(content);
    if (parsed === undefined) {
      throw new Error('Invalid JSON');
    }
    if (!isPlainObject(parsed)) {
      throw new Error('Expected a JSON object');
    }
    return parsed as Partial<AppConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
    }

    if (error instanceof Error) {
      throw new Error(`Failed to load provider config from ${filePath}: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function loadConfig(projectDir?: string): Promise<AppConfig> {
  const workspaceDir = projectDir || process.env.DYNAMIND_WORKSPACE_DIR || process.cwd();
  let config: AppConfig = {};

  for (const layer of [
    await readConfigFile(getDynamindPath('config.json')),
    await readConfigFile(path.join(path.resolve(workspaceDir), DYNAMIND_DIR, 'config.json')),
  ]) {
    config = deepMerge(config, layer);
  }

  return config;
}

export async function saveLastModel(model: string): Promise<void> {
  try {
    await ensureConfigDir();
    const configPath = getDynamindPath('config.json');
    const existing = await readConfigFile(configPath);
    const updated = { ...existing, lastModel: model };
    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    console.error('Failed to save last model:', error);
  }
}

