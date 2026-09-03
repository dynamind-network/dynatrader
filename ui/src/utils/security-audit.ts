/**
 * Security Audit Utilities
 * Verify no credentials in config files, no private keys in logs
 */

/**
 * Forbidden patterns that indicate exposed credentials
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // Ethereum private key (64 hex chars)
  { pattern: /\b0x[a-fA-F0-9]{64}\b/, name: 'Ethereum private key' },
  // Stripe live secret key
  { pattern: /\bsk_live_[a-zA-Z0-9]{24,}\b/, name: 'Stripe live key' },
  // Stripe live publishable key
  { pattern: /\bpk_live_[a-zA-Z0-9]{24,}\b/, name: 'Stripe publishable key' },
  // Hyperliquid private key env var
  { pattern: /\bHYPERLIQUID_PRIVATE_KEY\s*=\s*[a-zA-Z0-9]+/, name: 'Hyperliquid private key' },
  // Slack bot token
  { pattern: /\bxoxb-[a-zA-Z0-9]{10,}\b/, name: 'Slack bot token' },
  // GitHub personal access token
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, name: 'GitHub token' },
  // AWS Access Key ID
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key' },
];

/**
 * Safe patterns that should not be flagged
 */
const SAFE_PATTERNS = [
  // Test keys
  /sk_test_[a-zA-Z0-9]+/,
  /pk_test_[a-zA-Z0-9]+/,
  // Mock addresses
  /^0x0+$/,
  /^0x[fF]+$/,
  // Example/placeholder text
  /your_[a-zA-Z_]+_here/,
  /<[A-Z_]+>/,
];

/**
 * Required environment variables that must be present
 */
const REQUIRED_ENV_VARS = ['NODE_ENV'];

/**
 * Scan content for forbidden credential patterns
 * Returns array of found credential types
 */
export function scanForCredentials(content: string): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const found: string[] = [];

  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    // Reset lastIndex for non-global patterns used with test()
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match) {
      // CRITICAL: Test safe patterns against the matched substring, not entire content
      // This prevents a test key from suppressing detection of real credentials
      const matchedSubstring = match[0];
      const isSafe = SAFE_PATTERNS.some((safe) => safe.test(matchedSubstring));
      if (!isSafe) {
        found.push(name);
      }
    }
  }

  return found;
}

/**
 * Check if content contains any credentials
 */
export function hasCredentials(content: string): boolean {
  return scanForCredentials(content).length > 0;
}

/**
 * Check for missing required environment variables
 * Returns array of missing variable names
 */
export function checkRequiredEnvVars(env: Record<string, string>): string[] {
  const missing: string[] = [];

  for (const varName of REQUIRED_ENV_VARS) {
    if (!env[varName] || env[varName] === '') {
      missing.push(varName);
    }
  }

  return missing;
}

/**
 * Check if a config is secure (no credentials, has required vars)
 */
export function isSecureConfig(
  configContent: string,
  env?: Record<string, string>
): {
  secure: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for credentials in config
  const credIssues = scanForCredentials(configContent);
  if (credIssues.length > 0) {
    issues.push(`Found credentials: ${credIssues.join(', ')}`);
  }

  // Check required env vars
  if (env) {
    const missingVars = checkRequiredEnvVars(env);
    if (missingVars.length > 0) {
      issues.push(`Missing required env vars: ${missingVars.join(', ')}`);
    }
  }

  return {
    secure: issues.length === 0,
    issues,
  };
}

/**
 * Audit a file for security issues
 */
export async function auditFile(filePath: string): Promise<{
  secure: boolean;
  issues: string[];
}> {
  const { readFile } = await import('node:fs/promises');

  try {
    const content = await readFile(filePath, 'utf-8');
    return isSecureConfig(content);
  } catch (error) {
    return {
      secure: false,
      issues: [`Failed to read file: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Get security audit report for multiple files
 */
export async function auditFiles(filePaths: string[]): Promise<{
  totalFiles: number;
  secureFiles: number;
  issues: Array<{ file: string; issues: string[] }>;
}> {
  const results = await Promise.all(
    filePaths.map(async (path) => {
      const audit = await auditFile(path);
      return { file: path, ...audit };
    })
  );

  const issues = results
    .filter((r) => !r.secure)
    .map((r) => ({
      file: r.file,
      issues: r.issues,
    }));

  return {
    totalFiles: filePaths.length,
    secureFiles: results.filter((r) => r.secure).length,
    issues,
  };
}
