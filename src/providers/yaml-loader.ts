import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import type { ProviderEntry } from './types.js';

interface ModelsYAML {
  providers?: Record<
    string,
    {
      displayName?: string;
      env?: string[];
      baseUrl?: string;
      defaultModel?: string;
      models?: Array<{
        id: string;
        name: string;
        contextWindow: number;
        maxOutput: number;
      }>;
    }
  >;
}

let _cache: Record<string, ProviderEntry> | null = null;
let _cacheTimestamp = 0;

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_YAML_SIZE = 1024 * 1024;

const BLOCKED_URL_PATTERNS = [
  /^https?:\/\/(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/\[::1\]/i,
  /^https?:\/\/169\.254\./i,
  /^https?:\/\/metadata\.google\.internal/i,
  /^https?:\/\/169\.254\.169\.254/i,
  /^https?:\/\/fd00::/i,
  /^https?:\/\/fc00::/i,
  /^https?:\/\/fe80:/i,
  /^https?:\/\/\[::ffff:/i,
  /^https?:\/\/.*\.local/i,
  /^https?:\/\/.*\.internal/i,
  /^https?:\/\/.*\.localhost/i,
  /^\/\//i,
  /^file:/i,
  /^data:/i,
  /^javascript:/i,
  /^ftp:/i,
];

const ALLOWED_SCHEMES = ['https:'];

function validateBaseUrl(url: string | undefined, providerName: string): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      console.warn(`[models.yaml] Blocked non-HTTPS URL for provider "${providerName}": ${url}`);
      return undefined;
    }
  } catch {
    console.warn(`[models.yaml] Invalid URL for provider "${providerName}": ${url}`);
    return undefined;
  }

  if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) {
    console.warn(`[models.yaml] Blocked private/internal URL for provider "${providerName}": ${url}`);
    return undefined;
  }

  return url;
}

async function readYAMLFile(filePath: string): Promise<ModelsYAML | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    if (content.length > MAX_YAML_SIZE) {
      console.warn(`[models.yaml] Skipping ${filePath}: ${content.length} bytes exceeds 1MB limit`);
      return null;
    }

    const parsed = yaml.parse(content) as ModelsYAML | undefined;
    if (!parsed || typeof parsed !== 'object') return null;

    const MAX_DEPTH = 5;
    function checkDepth(obj: unknown, depth: number): boolean {
      if (depth > MAX_DEPTH) return false;
      if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj)) {
          if (!checkDepth(val, depth + 1)) return false;
        }
      }
      return true;
    }
    if (!checkDepth(parsed, 0)) {
      console.warn(`[models.yaml] Skipping ${filePath}: YAML nesting exceeds ${MAX_DEPTH} levels`);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function parseProviderEntry(
  name: string,
  raw: NonNullable<ModelsYAML['providers']>[string],
): ProviderEntry | null {
  if (!raw || typeof raw !== 'object') return null;

  const models = Array.isArray(raw.models)
    ? raw.models.filter(
        (m): m is { id: string; name: string; contextWindow: number; maxOutput: number } =>
          m &&
          typeof m === 'object' &&
          typeof m.id === 'string' &&
          typeof m.name === 'string' &&
          typeof m.contextWindow === 'number' &&
          typeof m.maxOutput === 'number',
      )
    : [];

  if (models.length === 0) return null;

  const validatedUrl = validateBaseUrl(
    typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
    name,
  );

  return {
    name,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : name,
    env: Array.isArray(raw.env) ? raw.env : [],
    baseUrl: validatedUrl,
    models,
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : models[0]!.id,
  };
}

function mergeProviders(
  base: Record<string, ProviderEntry>,
  override: ModelsYAML,
): Record<string, ProviderEntry> {
  const result: Record<string, ProviderEntry> = { ...base };

  if (!override.providers || typeof override.providers !== 'object') return result;

  for (const [name, raw] of Object.entries(override.providers)) {
    if (!raw || typeof raw !== 'object') continue;

    if (!Array.isArray(raw.models) || raw.models.length === 0) {
      if (result[name]) {
        const validatedUrl = validateBaseUrl(
          typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
          name,
        );
        result[name] = {
          ...result[name],
          ...(typeof raw.displayName === 'string' && { displayName: raw.displayName }),
          ...(Array.isArray(raw.env) && { env: raw.env }),
          ...(validatedUrl !== undefined && { baseUrl: validatedUrl }),
          ...(typeof raw.defaultModel === 'string' && { defaultModel: raw.defaultModel }),
        };
      }
      continue;
    }

    const parsed = parseProviderEntry(name, raw);
    if (parsed) {
      result[name] = parsed;
    }
  }

  return result;
}

function getDynaTraderPath(...segments: string[]): string {
  return path.join(homedir(), '.dynatrader', ...segments);
}

export interface LoadOptions {
  workspaceDir?: string;
  force?: boolean;
}

export async function loadProvidersFromYAML(
  options: LoadOptions = {},
): Promise<Record<string, ProviderEntry>> {
  if (_cache && !options.force) {
    if (Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
      return _cache;
    }
    _cache = null;
  }

  const workspaceDir = options.workspaceDir || process.env.DYNATRADER_WORKSPACE_DIR || process.cwd();

  let providers: Record<string, ProviderEntry> = {};

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultYAMLPath = thisDir.endsWith(path.join('dist', 'providers'))
    ? path.join(thisDir, '../../src/providers/models.default.yaml')
    : path.join(thisDir, 'models.default.yaml');
  const defaultYAML = await readYAMLFile(defaultYAMLPath);
  if (defaultYAML) {
    providers = mergeProviders(providers, defaultYAML);
  }

  const globalYAMLPath = getDynaTraderPath('models.yaml');
  const globalYAML = await readYAMLFile(globalYAMLPath);
  if (globalYAML) {
    providers = mergeProviders(providers, globalYAML);
  }

  const workspaceYAMLPath = path.join(workspaceDir, '.dynatrader', 'models.yaml');
  if (workspaceYAMLPath !== globalYAMLPath) {
    const workspaceYAML = await readYAMLFile(workspaceYAMLPath);
    if (workspaceYAML) {
      providers = mergeProviders(providers, workspaceYAML);
    }
  }

  _cache = providers;
  _cacheTimestamp = Date.now();
  return providers;
}

export function invalidateProvidersCache(): void {
  _cache = null;
  _cacheTimestamp = 0;
}
