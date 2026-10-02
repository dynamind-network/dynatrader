import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { PROVIDERS } from '../providers/registry.js';

const DYNAMIND_DIR = '.dynamind';
const DYNATRADER_DIR = '.dynatrader';

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function getTerminalAuthPath(): string {
  return path.join(getHomeDir(), DYNAMIND_DIR, 'auth.json');
}

function getCoreAuthPath(): string {
  return path.join(getHomeDir(), DYNATRADER_DIR, 'auth-profiles.json');
}

interface TerminalAuthEntry {
  type: 'api' | 'oauth' | 'wellknown';
  key?: string;
  token?: string;
}

interface CoreAuthProfile {
  provider?: string;
  type?: string;
  key?: string;
  token?: string;
}

interface CoreAuthStore {
  profiles?: Record<string, CoreAuthProfile>;
}

async function readTerminalAuth(): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  try {
    const content = await fs.readFile(getTerminalAuthPath(), 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    for (const [providerId, entry] of Object.entries(data)) {
      const auth = entry as TerminalAuthEntry;
      if (auth.type === 'api' && auth.key?.trim()) {
        keys[providerId] = auth.key.trim();
      } else if (auth.type === 'wellknown' && auth.key?.trim()) {
        keys[providerId] = auth.key.trim();
      } else if (auth.type === 'oauth' && auth.token?.trim()) {
        keys[providerId] = auth.token.trim();
      }
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return keys;
}

async function readCoreAuth(): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  try {
    const content = await fs.readFile(getCoreAuthPath(), 'utf-8');
    const store = JSON.parse(content) as CoreAuthStore;
    if (!store.profiles) return keys;
    for (const [, cred] of Object.entries(store.profiles)) {
      if (cred.provider && cred.type === 'api_key' && cred.key?.trim()) {
        keys[cred.provider] = cred.key.trim();
      } else if (cred.provider && cred.type === 'token' && cred.token?.trim()) {
        keys[cred.provider] = cred.token.trim();
      }
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return keys;
}

function readEnvVarKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    for (const envVar of provider.env) {
      const value = process.env[envVar];
      if (value?.trim()) {
        keys[name] = value.trim();
        break;
      }
    }
  }
  return keys;
}

export interface KeyResolverOptions {
  workspaceDir?: string;
}

export async function resolveApiKeys(
  options: KeyResolverOptions = {},
): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};

  const envKeys = readEnvVarKeys();
  Object.assign(keys, envKeys);

  const terminalKeys = await readTerminalAuth();
  for (const [name, key] of Object.entries(terminalKeys)) {
    if (!keys[name]) {
      keys[name] = key;
    }
  }

  const coreKeys = await readCoreAuth();
  for (const [name, key] of Object.entries(coreKeys)) {
    if (!keys[name]) {
      keys[name] = key;
    }
  }

  if (options.workspaceDir) {
    const workspaceConfigPath = path.join(options.workspaceDir, DYNATRADER_DIR, 'config.yaml');
    try {
      const content = await fs.readFile(workspaceConfigPath, 'utf-8');
      const config = JSON.parse(content) as Record<string, unknown>;
      const models = config['models'] as Record<string, unknown> | undefined;
      if (models && typeof models['apiKey'] === 'string' && models['apiKey'].trim()) {
        const provider = (models['provider'] as string) || 'openai';
        if (!keys[provider]) {
          keys[provider] = models['apiKey'].trim();
        }
      }
    } catch {
      // Config doesn't exist
    }
  }

  if (!keys['lmstudio']) {
    keys['lmstudio'] = process.env.LM_STUDIO_API_KEY || '';
  }

  return keys;
}
