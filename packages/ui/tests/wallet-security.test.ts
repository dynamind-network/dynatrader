/**
 * Wallet Security Tests - Phase 2
 * Tests for credential output scrubbing, agent tool permissions, and security audit
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext, ToolResult } from '../src/core/types.js';
import { BaseTool } from '../src/tools/base-tool.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';

// ============================================================================
// TASK-007: Output Scrubbing for Credentials
// ============================================================================

/**
 * Credential patterns that should be scrubbed from tool output
 */
const CREDENTIAL_PATTERNS = [
  { pattern: '0x[a-fA-F0-9]{64}', name: 'Ethereum private key' },
  { pattern: 'pk_live_[a-zA-Z0-9]{24,}', name: 'Stripe live key' },
  { pattern: 'HYPERLIQUID_PRIVATE_KEY', name: 'Hyperliquid private key env var' },
  { pattern: 'HYPERLIQUID_ADDRESS', name: 'Hyperliquid address env var' },
  { pattern: 'sk_live_[a-zA-Z0-9]{24,}', name: 'Stripe secret key' },
  { pattern: 'xoxb-[a-zA-Z0-9]{10,}', name: 'Slack bot token' },
  { pattern: 'ghp_[a-zA-Z0-9]{36}', name: 'GitHub personal token' },
  { pattern: 'AKIA[0-9A-Z]{16}', name: 'AWS access key' },
];

describe('TASK-007: Output Scrubbing for Credentials', () => {
  let scrubOutput: (output: string) => string;

  beforeEach(async () => {
    // Import the scrub function - will fail until implemented
    const { scrubCredentials } = await import('../src/utils/output-scrubbing.js');
    scrubOutput = scrubCredentials;
  });

  it('should scrub Ethereum private keys from output', () => {
    const output =
      'Transaction sent! Private key: 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).not.toContain(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    );
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('should scrub Stripe live keys from output', () => {
    const output = 'API response: sk_live_51MzXYZ1234567890abcdefghijklmnop';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).not.toContain('sk_live_51');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('should scrub Hyperliquid private key env var from output', () => {
    const output = 'Config loaded: HYPERLIQUID_PRIVATE_KEY=abc123def456';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).not.toContain('HYPERLIQUID_PRIVATE_KEY=');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('should scrub Hyperliquid address from output', () => {
    const output = 'Using wallet: HYPERLIQUID_ADDRESS=0x1234567890abcdef1234567890abcdef12345678';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).not.toContain('HYPERLIQUID_ADDRESS=0x');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('should not scrub non-credential 0x addresses', () => {
    const output = 'Token address: 0x1234567890abcdef1234567890abcdef12345678';
    const scrubbed = scrubOutput(output);

    // Regular Ethereum addresses (42 chars, 0x + 40 hex) should NOT be scrubbed
    expect(scrubbed).toContain('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('should handle multiple credentials in same output', () => {
    const output = 'Keys: sk_live_51MzXYZ1234567890abcdefghijklmnop AND HYPERLIQUID_PRIVATE_KEY=secret';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).not.toContain('sk_live_');
    expect(scrubbed).not.toContain('HYPERLIQUID_PRIVATE_KEY=');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('should return original output if no credentials found', () => {
    const output = 'Hello, this is a normal message with no secrets';
    const scrubbed = scrubOutput(output);

    expect(scrubbed).toBe(output);
  });
});

// Test that tool output is automatically scrubbed
describe('TASK-007: Tool Output Auto-Scrubbing', () => {
  class CredentialLeakingTool extends BaseTool {
    name = 'leak-test';
    description = 'Test tool that accidentally leaks credentials';
    inputSchema = {
      type: 'object' as const,
      properties: {},
      required: [],
    };
    isDestructive = false;
    readOnly = true;

    async execute(): Promise<ToolResult> {
      // Simulate a tool that accidentally outputs credentials
      return {
        success: true,
        output:
          'API Response: sk_live_51MzXYZ1234567890abcdefghijklmnop\nTransaction: 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      };
    }
  }

  it('should automatically scrub credentials from tool results', async () => {
    const { scrubCredentials } = await import('../src/utils/output-scrubbing.js');
    const tool = new CredentialLeakingTool();
    const context: ToolExecutionContext = {
      workingDirectory: '/tmp',
      conversationId: 'test',
      isSubagent: false,
    };

    const result = await tool.execute({}, context);
    const scrubbed = scrubCredentials(result.output);

    expect(scrubbed).not.toContain('sk_live_');
    expect(scrubbed).not.toContain(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    );
  });
});

// ============================================================================
// TASK-008: Agent Tool Permissions
// ============================================================================

describe('TASK-008: Agent Tool Permissions', () => {
  interface AgentPermission {
    agentType: string;
    allowedTools: string[];
    deniedTools: string[];
  }

  const permissionMatrix: AgentPermission[] = [
    {
      agentType: 'trader',
      allowedTools: [
        'execute_trade',
        'cancel_order',
        'get_positions',
        'get_balance',
        'set_leverage',
        'set_stop_loss',
        'set_take_profit',
      ],
      deniedTools: [],
    },
    {
      agentType: 'analyst',
      allowedTools: [
        'get_positions',
        'get_balance',
        'get_market_data',
        'get_order_book',
        'get_trade_history',
        'calculate_indicators',
      ],
      deniedTools: [
        'execute_trade',
        'cancel_order',
        'set_leverage',
        'set_stop_loss',
        'set_take_profit',
      ],
    },
    {
      agentType: 'researcher',
      allowedTools: [
        'get_market_data',
        'get_order_book',
        'get_trade_history',
        'calculate_indicators',
        'web_search',
        'web_fetch',
      ],
      deniedTools: [
        'execute_trade',
        'cancel_order',
        'get_positions',
        'get_balance',
        'set_leverage',
        'set_stop_loss',
        'set_take_profit',
      ],
    },
  ];

  function getAgentPermissions(agentType: string): AgentPermission | undefined {
    return permissionMatrix.find((p) => p.agentType === agentType);
  }

  function canAgentUseTool(agentType: string, toolName: string): boolean {
    const perms = getAgentPermissions(agentType);
    if (!perms) return false;
    return perms.allowedTools.includes(toolName);
  }

  it('trader agent can use execute_trade', () => {
    expect(canAgentUseTool('trader', 'execute_trade')).toBe(true);
  });

  it('trader agent can use get_positions', () => {
    expect(canAgentUseTool('trader', 'get_positions')).toBe(true);
  });

  it('trader agent cannot use web_search', () => {
    expect(canAgentUseTool('trader', 'web_search')).toBe(false);
  });

  it('analyst agent cannot use execute_trade', () => {
    expect(canAgentUseTool('analyst', 'execute_trade')).toBe(false);
  });

  it('analyst agent can use get_positions (read-only)', () => {
    expect(canAgentUseTool('analyst', 'get_positions')).toBe(true);
  });

  it('analyst agent can use calculate_indicators', () => {
    expect(canAgentUseTool('analyst', 'calculate_indicators')).toBe(true);
  });

  it('researcher agent can use get_market_data', () => {
    expect(canAgentUseTool('researcher', 'get_market_data')).toBe(true);
  });

  it('researcher agent cannot use execute_trade', () => {
    expect(canAgentUseTool('researcher', 'execute_trade')).toBe(false);
  });

  it('researcher agent can use web_search', () => {
    expect(canAgentUseTool('researcher', 'web_search')).toBe(true);
  });

  it('unknown agent type has no permissions', () => {
    expect(canAgentUseTool('unknown', 'execute_trade')).toBe(false);
  });
});

// Test tool permission enforcement in registry
describe('TASK-008: Tool Permission Enforcement', () => {
  class TradingTool extends BaseTool {
    name = 'execute_trade';
    description = 'Execute a trade';
    inputSchema = {
      type: 'object' as const,
      properties: { symbol: { type: 'string' }, side: { type: 'string' } },
      required: ['symbol', 'side'],
    };
    isDestructive = true;
    mutatesExternalState = true;
    requiresApproval = true;

    async execute(): Promise<ToolResult> {
      return { success: true, output: 'Trade executed' };
    }
  }

  class ReadOnlyTool extends BaseTool {
    name = 'get_positions';
    description = 'Get positions';
    inputSchema = {
      type: 'object' as const,
      properties: {},
      required: [],
    };
    isDestructive = false;
    readOnly = true;

    async execute(): Promise<ToolResult> {
      return { success: true, output: 'Positions: []' };
    }
  }

  it('should enforce tool permissions based on agent type', async () => {
    const { checkToolPermission } = await import('../src/utils/tool-permissions.js');

    // Trader can use trading tools
    expect(checkToolPermission('trader', 'execute_trade')).toBe(true);
    expect(checkToolPermission('trader', 'get_positions')).toBe(true);

    // Analyst cannot use execute_trade
    expect(checkToolPermission('analyst', 'execute_trade')).toBe(false);
    expect(checkToolPermission('analyst', 'get_positions')).toBe(true);

    // Researcher cannot use trading tools
    expect(checkToolPermission('researcher', 'execute_trade')).toBe(false);
    expect(checkToolPermission('researcher', 'get_market_data')).toBe(true);
  });

  it('should filter registry tools based on agent permissions', async () => {
    const registry = new ToolRegistry();
    registry.register(new TradingTool(), false, 'trading-server');
    registry.register(new ReadOnlyTool(), false, 'trading-server');

    const { filterToolsForAgent } = await import('../src/utils/tool-permissions.js');
    const filtered = filterToolsForAgent(registry, 'analyst');

    expect(filtered.has('get_positions')).toBe(true);
    expect(filtered.has('execute_trade')).toBe(false);
  });
});

// ============================================================================
// TASK-009: Security Audit Test
// ============================================================================

describe('TASK-009: Security Audit Test', () => {
  const FORBIDDEN_PATTERNS = [
    { pattern: /0x[a-fA-F0-9]{64}/, name: 'Ethereum private key' },
    { pattern: /pk_live_[a-zA-Z0-9]+/, name: 'Stripe live key' },
    { pattern: /sk_live_[a-zA-Z0-9]+/, name: 'Stripe secret key' },
    { pattern: /HYPERLIQUID_PRIVATE_KEY\s*=\s*[a-zA-Z0-9]+/, name: 'Hyperliquid private key' },
    { pattern: /xoxb-[a-zA-Z0-9]+/, name: 'Slack bot token' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub token' },
    { pattern: /AKIA[0-9A-Z]{16}/, name: 'AWS access key' },
  ];

  const REQUIRED_ENV_VARS = ['NODE_ENV'];

  function scanForCredentials(content: string): string[] {
    const found: string[] = [];
    for (const { pattern, name } of FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        found.push(name);
      }
    }
    return found;
  }

  function checkRequiredEnvVars(env: Record<string, string>): string[] {
    const missing: string[] = [];
    for (const varName of REQUIRED_ENV_VARS) {
      if (!env[varName] || env[varName] === '') {
        missing.push(varName);
      }
    }
    return missing;
  }

  it('should detect Ethereum private key in config', () => {
    const configContent = `
export const config = {
  privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  apiUrl: "https://api.example.com"
};
`;
    const found = scanForCredentials(configContent);
    expect(found).toContain('Ethereum private key');
  });

  it('should detect Stripe live key in config', () => {
    const configContent = `
const STRIPE_KEY = "pk_live_51MzXYZ1234567890abcdefghijklmnop";
`;
    const found = scanForCredentials(configContent);
    expect(found).toContain('Stripe live key');
  });

  it('should detect Hyperliquid private key in env export', () => {
    const configContent = `
export HYPERLIQUID_PRIVATE_KEY=abc123def456
`;
    const found = scanForCredentials(configContent);
    expect(found).toContain('Hyperliquid private key');
  });

  it('should not flag test/mock keys as forbidden', () => {
    const configContent = `
const TEST_KEY = "sk_test_51MzXYZ1234567890abcdefghijklmnop";
const MOCK_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
`;
    const found = scanForCredentials(configContent);
    // Test keys should not be flagged as real credentials
    expect(found).not.toContain('Stripe live key');
  });

  it('should detect missing required env vars', () => {
    const env = { NODE_ENV: '' };
    const missing = checkRequiredEnvVars(env);
    expect(missing).toContain('NODE_ENV');
  });

  it('should pass when no credentials present', () => {
    const safeContent = `
export const config = {
  apiUrl: "https://api.example.com",
  timeout: 5000
};
`;
    const found = scanForCredentials(safeContent);
    expect(found).toHaveLength(0);
  });

  it('should pass when required env vars present', () => {
    const env = { NODE_ENV: 'production' };
    const missing = checkRequiredEnvVars(env);
    expect(missing).toHaveLength(0);
  });
});

// Test security audit utility
describe('TASK-009: Security Audit Utility', () => {
  it('should export security audit functions', async () => {
    const { scanForCredentials, checkRequiredEnvVars, isSecureConfig } =
      await import('../src/utils/security-audit.js');

    expect(typeof scanForCredentials).toBe('function');
    expect(typeof checkRequiredEnvVars).toBe('function');
    expect(typeof isSecureConfig).toBe('function');
  });

  it('should identify secure config', async () => {
    const { isSecureConfig } = await import('../src/utils/security-audit.js');

    const secureConfig = `
export const API_URL = "https://api.example.com";
export const TIMEOUT = 5000;
`;
    expect(isSecureConfig(secureConfig).secure).toBe(true);
  });

  it('should identify insecure config', async () => {
    const { isSecureConfig } = await import('../src/utils/security-audit.js');

    const insecureConfig = `
export const PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
`;
    expect(isSecureConfig(insecureConfig).secure).toBe(false);
  });
});
