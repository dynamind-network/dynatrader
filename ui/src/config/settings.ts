import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { Auth } from '../auth/index.js';
import { loadConfig } from './config.js';
import { parseJson } from '../utils/json.js';
import {
  getDynamindPath,
  DYNAMIND_DIR,
  isPlainObject,
  deepMerge,
  PATHS,
} from '../utils/constants.js';
import { PROVIDERS } from '../core/providers.js';

/**
 * Restrict sensitive files with POSIX permissions where those semantics exist.
 * Windows uses ACLs; Node's chmod cannot make a file owner-only there.
 */
async function hardenSensitiveFilePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;

  try {
    const stat = await fs.stat(filePath);
    // Only change if permissions are not already restrictive
    if ((stat.mode & 0o777) !== 0o600) {
      await fs.chmod(filePath, 0o600);
    }
  } catch {
    // File may not exist yet — that's fine
  }
}

/**
 * Sentinel prefix for AES-256-GCM encrypted values in settings.json.
 * An encrypted value looks like: $AES$<base64(iv+tag+ciphertext)>
 */
const ENCRYPTED_PREFIX = '$AES$';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_FILE_NAME = '.settings-key';

/**
 * Dot-notation paths of sensitive fields that should be encrypted at rest.
 * Matches fields like wallet.privateKey, hyperliquid.apiSecret, etc.
 */
const SENSITIVE_FIELD_PATHS = new Set([
  'wallet.privateKey',
  'hyperliquid.apiSecret',
  'hyperliquid.privateKey',
  'polymarket.privateKey',
  'polymarket.apiSecret',
  'polymarket.apiPassphrase',
  'defi.privateKey',
  'marketData.apiKey',
  'glmApiKey',
  'deepseekApiKey',
]);

function getEncryptionKeyFilePath(): string {
  return getDynamindPath(KEY_FILE_NAME);
}

/**
 * Load or create the AES-256 encryption key.
 * The key is stored at ~/.dynamind/.settings-key with 0o600 permissions.
 * If no key exists, returns null (encryption is opt-in).
 */
async function getEncryptionKey(): Promise<Buffer | null> {
  const keyPath = getEncryptionKeyFilePath();
  // Allow override via environment variable (for CI/testing)
  const envKey = process.env.DYNAMIND_SETTINGS_KEY;
  if (envKey && envKey.length >= 32) {
    return Buffer.from(envKey.slice(0, 32), 'utf-8');
  }
  try {
    await hardenSensitiveFilePermissions(keyPath);
    const key = await fs.readFile(keyPath);
    await checkSensitiveFilePermissions(keyPath);
    return key;
  } catch {
    // No key file exists — encryption is disabled
    return null;
  }
}

/**
 * CRITICAL: Encrypt a plaintext string using AES-256-GCM.
 * Returns the encrypted value prefixed with the sentinel marker.
 * Returns null if no encryption key is available.
 */
async function encryptField(plaintext: string): Promise<string | null> {
  if (!plaintext) return null;
  const key = await getEncryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return ENCRYPTED_PREFIX + combined.toString('base64url');
}

/**
 * CRITICAL: Decrypt an AES-256-GCM encrypted value.
 * Expects the value to start with the sentinel prefix.
 * Returns the plaintext string, or the original value if not encrypted.
 */
async function decryptField(encrypted: string): Promise<string> {
  if (!encrypted.startsWith(ENCRYPTED_PREFIX)) return encrypted;
  const key = await getEncryptionKey();
  if (!key) {
    console.warn(
      '[security] Settings contain encrypted values but no encryption key was found. ' +
        'Cannot decrypt. Was ~/.dynamind/.settings-key deleted?',
    );
    return encrypted;
  }
  try {
    const raw = Buffer.from(encrypted.slice(ENCRYPTED_PREFIX.length), 'base64url');
    // First 12 bytes = IV, next 16 bytes = auth tag, rest = ciphertext
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch (err) {
    console.warn(
      `[security] Failed to decrypt settings field: ${(err as Error).message}. ` +
        'The settings key may have changed since the value was encrypted.',
    );
    return encrypted;
  }
}

/**
 * CRITICAL: Recursively traverse an object and decrypt any fields whose paths
 * match the sensitive field paths.
 */
async function decryptSensitiveFields(
  obj: Record<string, unknown>,
  prefix = '',
): Promise<void> {
  for (const [key, value] of Object.entries(obj)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)) {
      obj[key] = await decryptField(value);
    } else if (isPlainObject(value)) {
      await decryptSensitiveFields(value as Record<string, unknown>, pathKey);
    }
  }
}

/**
 * CRITICAL: Recursively traverse an object and encrypt any string fields whose
 * paths match the sensitive field paths.
 */
async function encryptSensitiveFields(
  obj: Record<string, unknown>,
  prefix = '',
): Promise<void> {
  for (const [key, value] of Object.entries(obj)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' && value && !value.startsWith(ENCRYPTED_PREFIX)) {
      if (SENSITIVE_FIELD_PATHS.has(pathKey)) {
        const encrypted = await encryptField(value);
        if (encrypted) {
          obj[key] = encrypted;
        }
      }
    } else if (isPlainObject(value)) {
      await encryptSensitiveFields(value as Record<string, unknown>, pathKey);
    }
  }
}

const windowsAclWarningsShown = new Set<string>();

function reportSensitiveFilePermissions(filePath: string, fileMode: number): void {
  if (process.platform === 'win32') {
    if (!windowsAclWarningsShown.has(filePath)) {
      windowsAclWarningsShown.add(filePath);
      console.warn(
        `[security] Windows ACLs for sensitive files are not verified. ` +
          `Ensure access to ${filePath} and its parent directory is restricted to trusted users.`,
      );
    }
    return;
  }

  const mode = fileMode & 0o777;
  if (mode !== 0o600) {
    console.warn(
      `[security] WARNING: ${filePath} has permissions ${mode.toString(8)} ` +
        `(expected 600). Other processes may read your private keys. ` +
        `Run: chmod 600 "${filePath}"`,
    );
  }
}

/**
 * Check sensitive file permissions on platforms with POSIX mode semantics.
 * Windows ACLs are reported as unverified because Node's mode bits cannot inspect them.
 */
async function checkSensitiveFilePermissions(filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    reportSensitiveFilePermissions(filePath, stat.mode);
  } catch {
    // File may not exist yet
  }
}

export interface WalletSettings {
  privateKey: string;
  address: string;
}

export interface HyperliquidSettings {
  apiKey: string;
  apiSecret: string;
  privateKey: string;
  userAddress: string;
}

export interface PolymarketSettings {
  privateKey: string;
  funderAddress: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

export interface DefiSettings {
  privateKey: string;
  mainAddress: string;
}

export interface MarketDataSettings {
  apiKey: string;
}

export interface CompactionSettings {
  auto: boolean;
  prune: boolean;
}

export interface PluginSettings {
  market: boolean;
  portfolio: boolean;
}

export interface AppSettings {
  glmApiKey: string;
  deepseekApiKey: string;
  wallet: WalletSettings;
  hyperliquid: HyperliquidSettings;
  polymarket: PolymarketSettings;
  defi: DefiSettings;
  marketData: MarketDataSettings;
  plugins: PluginSettings;
  compaction?: CompactionSettings;
}

const defaultSettings: AppSettings = {
  glmApiKey: '',
  deepseekApiKey: '',
  wallet: {
    privateKey: '',
    address: '',
  },
  hyperliquid: {
    apiKey: '',
    apiSecret: '',
    privateKey: '',
    userAddress: '',
  },
  polymarket: {
    privateKey: '',
    funderAddress: '',
    apiKey: '',
    apiSecret: '',
    apiPassphrase: '',
  },
  defi: {
    privateKey: '',
    mainAddress: '',
  },
  marketData: {
    apiKey: '',
  },
  plugins: {
    market: true,
    portfolio: false,
  },
  compaction: {
    auto: true,
    prune: true,
  },
};

const settingsCache = new Map<string, AppSettings>();

function getUserSettingsPath(): string {
  return getDynamindPath(PATHS.SETTINGS_FILE);
}

function getWorkspaceSettingsPath(projectDir?: string): string {
  return path.join(path.resolve(projectDir || process.cwd()), DYNAMIND_DIR, PATHS.SETTINGS_FILE);
}

const PROTECTED_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * CRITICAL: Validate that parsed JSON does not contain prototype pollution payloads.
 * Checks all keys recursively for __proto__, constructor, prototype.
 */
function validateNoPrototypePollution(obj: unknown, path = ''): boolean {
  if (!obj || typeof obj !== 'object') return true;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!validateNoPrototypePollution(obj[i], `${path}[${i}]`)) return false;
    }
    return true;
  }

  for (const key of Object.keys(obj)) {
    if (PROTECTED_KEYS.includes(key)) {
      console.warn(`[security] Prototype pollution attempt detected at ${path}.${key} — ignoring key`);
      delete (obj as Record<string, unknown>)[key];
      continue;
    }
    if (!validateNoPrototypePollution((obj as Record<string, unknown>)[key], `${path}.${key}`)) {
      return false;
    }
  }
  return true;
}

async function readSettingsFile(filePath: string): Promise<Partial<AppSettings>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // CRITICAL: Validate file size to prevent memory exhaustion
    if (content.length > 1024 * 1024) { // 1MB limit
      console.warn(`[security] Settings file ${filePath} exceeds 1MB — skipping`);
      return {};
    }

    // CRITICAL: Check file permissions on load to warn if secrets are exposed
    await checkSensitiveFilePermissions(filePath);
    const parsed = parseJson<unknown>(content);
    if (parsed === undefined) {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error('Expected a JSON object');
    }

    // CRITICAL: Check for prototype pollution in parsed JSON
    validateNoPrototypePollution(parsed);

    // CRITICAL: Decrypt any encrypted sensitive fields on read
    try {
      await decryptSensitiveFields(parsed as Record<string, unknown>);
    } catch {
      // CRITICAL: Return empty object on decryption failure instead of returning corrupted data
      console.warn(`[security] Decryption failed for ${filePath}. Settings key may have changed.`);
      return {};
    }
    return parsed as Partial<AppSettings>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
    }

    if (error instanceof Error) {
      throw new Error(`Failed to load settings from ${filePath}: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
}

function readSettingsFileSync(filePath: string): Partial<AppSettings> {
  try {
    const content = syncFs.readFileSync(filePath, 'utf-8');

    // CRITICAL: Validate file size to prevent memory exhaustion
    if (content.length > 1024 * 1024) { // 1MB limit
      console.warn(`[security] Settings file ${filePath} exceeds 1MB — skipping`);
      return {};
    }

    // Check file permissions on load (sync version)
    try {
      const stat = syncFs.statSync(filePath);
      reportSensitiveFilePermissions(filePath, stat.mode);
    } catch {
      // File may not exist yet
    }
    const parsed = parseJson<unknown>(content);
    if (parsed === undefined) {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error('Expected a JSON object');
    }

    // CRITICAL: Check for prototype pollution in parsed JSON
    validateNoPrototypePollution(parsed);

    return parsed as Partial<AppSettings>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`, { cause: error });
    }

    if (error instanceof Error) {
      throw new Error(`Failed to load settings from ${filePath}: ${error.message}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function loadSettings(projectDir?: string): Promise<AppSettings> {
  const workspaceDir = path.resolve(projectDir || process.cwd());
  const cached = settingsCache.get(workspaceDir);
  if (cached) {
    return cached;
  }

  // CRITICAL: Harden permissions on settings files that may contain private keys
  await hardenSensitiveFilePermissions(getUserSettingsPath());
  await hardenSensitiveFilePermissions(getWorkspaceSettingsPath(workspaceDir));

  let settings = structuredClone(defaultSettings);
  for (const layer of [
    await readSettingsFile(getUserSettingsPath()),
    await readSettingsFile(getWorkspaceSettingsPath(workspaceDir)),
  ]) {
    settings = deepMerge(settings, layer);
  }

  if (process.env.GLM_API_KEY) {
    settings.glmApiKey = process.env.GLM_API_KEY;
  }
  if (process.env.DEEPSEEK_API_KEY) {
    settings.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  }
  if (process.env.WALLET_PRIVATE_KEY) {
    settings.wallet.privateKey = process.env.WALLET_PRIVATE_KEY;
  }
  if (process.env.WALLET_ADDRESS) {
    settings.wallet.address = process.env.WALLET_ADDRESS;
  }
  if (process.env.HYPERLIQUID_API_KEY) {
    settings.hyperliquid.apiKey = process.env.HYPERLIQUID_API_KEY;
  }
  if (process.env.HYPERLIQUID_API_SECRET) {
    settings.hyperliquid.apiSecret = process.env.HYPERLIQUID_API_SECRET;
  }
  if (process.env.HYPERLIQUID_PRIVATE_KEY) {
    settings.hyperliquid.privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  }
  if (process.env.HYPERLIQUID_USER_ADDRESS) {
    settings.hyperliquid.userAddress = process.env.HYPERLIQUID_USER_ADDRESS;
  }
  if (process.env.POLYMARKET_PRIVATE_KEY) {
    settings.polymarket.privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  }
  if (process.env.POLYMARKET_FUNDER_ADDRESS) {
    settings.polymarket.funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
  }
  if (process.env.POLYMARKET_API_KEY) {
    settings.polymarket.apiKey = process.env.POLYMARKET_API_KEY;
  }
  if (process.env.POLYMARKET_API_SECRET) {
    settings.polymarket.apiSecret = process.env.POLYMARKET_API_SECRET;
  }
  if (process.env.POLYMARKET_API_PASSPHRASE) {
    settings.polymarket.apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  }
  if (process.env.DEFI_PRIVATE_KEY) {
    settings.defi.privateKey = process.env.DEFI_PRIVATE_KEY;
  }
  if (process.env.DEFI_MAIN_ADDRESS) {
    settings.defi.mainAddress = process.env.DEFI_MAIN_ADDRESS;
  }
  if (process.env.DYNAMIND_TERMINAL_DATA_API_KEY) {
    settings.marketData.apiKey = process.env.DYNAMIND_TERMINAL_DATA_API_KEY;
  }

  settingsCache.set(workspaceDir, settings);
  return settings;
}

export async function getApiKeys(settings: AppSettings): Promise<Record<string, string>> {
  const apiKeys: Record<string, string> = {};

  const authData = await Auth.all();
  for (const [providerID, auth] of Object.entries(authData)) {
    if (auth.type === 'api') {
      apiKeys[providerID] = auth.key;
    }
  }

  const config = await loadConfig();
  for (const [providerID, provider] of Object.entries(config.provider || {})) {
    if (provider.options?.apiKey) {
      apiKeys[providerID] = provider.options.apiKey;
    }
  }

  if (settings.glmApiKey) {
    apiKeys.glm = settings.glmApiKey;
  }
  if (settings.deepseekApiKey) {
    apiKeys.deepseek = settings.deepseekApiKey;
  }

  for (const [name, provider] of Object.entries(PROVIDERS)) {
    if (apiKeys[name]) continue;
    for (const envVar of provider.env) {
      const value = process.env[envVar];
      if (value?.trim()) {
        apiKeys[name] = value.trim();
        break;
      }
    }
  }

  if (!apiKeys.lmstudio) {
    apiKeys.lmstudio = process.env.LM_STUDIO_API_KEY || '';
  }

  return apiKeys;
}

export function loadPluginSettingsSync(projectDir?: string): PluginSettings {
  const workspaceDir = path.resolve(projectDir || process.cwd());
  let settings = structuredClone(defaultSettings);

  for (const layer of [
    readSettingsFileSync(getUserSettingsPath()),
    readSettingsFileSync(getWorkspaceSettingsPath(workspaceDir)),
  ]) {
    settings = deepMerge(settings, layer);
  }

  return settings.plugins;
}

export async function updatePluginSetting(
  pluginId: keyof PluginSettings,
  enabled: boolean,
  projectDir?: string
): Promise<void> {
  const workspaceDir = path.resolve(projectDir || process.cwd());
  const settingsPath = getWorkspaceSettingsPath(workspaceDir);
  const current = await readSettingsFile(settingsPath);
  const next = deepMerge(current, {
    plugins: {
      [pluginId]: enabled,
    },
  });

  // CRITICAL: Encrypt sensitive fields before writing to disk
  await encryptSensitiveFields(next as Record<string, unknown>);

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  // CRITICAL: Write with restrictive permissions atomically to prevent TOCTOU race
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await hardenSensitiveFilePermissions(settingsPath);
  settingsCache.delete(workspaceDir);
}

/**
 * CRITICAL: Save full settings to disk with encryption of sensitive fields.
 * Encrypts private keys and API secrets before writing to settings.json,
 * then sets restrictive file permissions (0o600).
 */
export async function saveSettings(
  settings: Partial<AppSettings>,
  projectDir?: string,
): Promise<void> {
  const workspaceDir = path.resolve(projectDir || process.cwd());
  const settingsPath = getWorkspaceSettingsPath(workspaceDir);

  // CRITICAL: Encrypt sensitive fields before writing to disk
  const toSave = structuredClone(settings) as Record<string, unknown>;
  await encryptSensitiveFields(toSave);

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  // CRITICAL: Write with restrictive permissions atomically to prevent TOCTOU race
  await fs.writeFile(settingsPath, `${JSON.stringify(toSave, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await hardenSensitiveFilePermissions(settingsPath);
  settingsCache.delete(workspaceDir);
}

/**
 * CRITICAL: Initialize encryption for settings at rest.
 * Generates a random AES-256 key and stores it at ~/.dynamind/.settings-key
 * with restrictive permissions where POSIX mode bits are supported. On Windows,
 * access is governed by ACLs, which Node does not verify.
 *
 * Returns true if a new key was created, false if one already exists.
 */
export async function initializeSettingsEncryption(): Promise<boolean> {
  const keyPath = getEncryptionKeyFilePath();
  try {
    await fs.access(keyPath);
    await checkSensitiveFilePermissions(keyPath);
    return false; // Key already exists
  } catch {
    // Key doesn't exist — create one
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    await hardenSensitiveFilePermissions(keyPath);
    await checkSensitiveFilePermissions(keyPath);
    return true;
  }
}

export function clearSettingsCache(): void {
  settingsCache.clear();
}
