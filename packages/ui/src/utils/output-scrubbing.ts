/**
 * Output Scrubbing Utilities
 * Ensures credentials never appear in agent tool output
 */

/**
 * Regex patterns for credential detection
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // Ethereum private key (64 hex chars = 32 bytes)
  { pattern: /\b0x[a-fA-F0-9]{64}\b/g, name: 'Ethereum private key' },
  // Stripe live secret key
  { pattern: /\bsk_live_[a-zA-Z0-9]{24,}\b/g, name: 'Stripe secret key' },
  // Stripe live publishable key
  { pattern: /\bpk_live_[a-zA-Z0-9]{24,}\b/g, name: 'Stripe publishable key' },
  // Hyperliquid private key env var
  { pattern: /\bHYPERLIQUID_PRIVATE_KEY\s*=\s*[a-zA-Z0-9]+/g, name: 'Hyperliquid private key' },
  // Hyperliquid address env var
  { pattern: /\bHYPERLIQUID_ADDRESS\s*=\s*0x[a-fA-F0-9]{40}/g, name: 'Hyperliquid address' },
  // Slack bot token
  { pattern: /\bxoxb-[a-zA-Z0-9]{10,}\b/g, name: 'Slack bot token' },
  // GitHub personal access token
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, name: 'GitHub token' },
  // AWS Access Key ID
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, name: 'AWS access key' },
];

/**
 * Patterns that should NOT be scrubbed (false positives)
 */
const SAFE_PATTERNS = [
  // Test keys
  /sk_test_[a-zA-Z0-9]+/,
  /pk_test_[a-zA-Z0-9]+/,
  // Mock addresses (all zeros or all ones)
  /^0x0+$/,
  /^0x[fF]+$/,
  /^0x0000/,
];

/**
 * Scrubs credentials from output string
 * Replaces detected credentials with [REDACTED] placeholder
 */
export function scrubCredentials(output: string): string {
  if (!output || typeof output !== 'string') {
    return output;
  }

  let scrubbed = output;

  for (const { pattern } of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  }

  return scrubbed;
}

/**
 * Checks if output contains any credentials
 */
export function containsCredentials(output: string): boolean {
  if (!output || typeof output !== 'string') {
    return false;
  }

  for (const { pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(output);
    if (match) {
      // CRITICAL: Test safe patterns against the matched substring, not entire content
      // This prevents a test key from suppressing detection of real credentials
      const matchedSubstring = match[0];
      const isSafe = SAFE_PATTERNS.some((safe) => safe.test(matchedSubstring));
      if (!isSafe) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Redacts a specific value completely
 */
export function redactValue(value: string): string {
  if (!value || typeof value !== 'string') {
    return value;
  }
  return '[REDACTED]';
}

/**
 * Creates a scrubbed version of an object, recursively processing all string values
 */
export function scrubObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return scrubCredentials(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = scrubObject(value);
    }
    return result as unknown as T;
  }

  return obj;
}

