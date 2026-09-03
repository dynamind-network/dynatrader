import { z } from 'zod';
import { AuditTrail, Logger } from '@dyna/audit';
import type { AuditEvent } from '@dyna/audit';
import type { PolicyTier, TransactionPolicyInput, TransactionPolicyEvaluation, SupportedChainId } from '../../wallet/types';

export interface PolicyInput {
  actor: string;
  actorType: 'user' | 'subagent' | 'skill' | 'tool' | 'system';
  requestedAction: string;
  mode: 'research' | 'backtest' | 'paper' | 'shadow' | 'micro_live' | 'live';
  artifact?: any;
  workspaceContext: any;
  riskProfile?: any;
  tradingPolicy?: any;
  auth?: any;
}

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  reasons: string[];
  requiredApprovals?: string[];
  auditLevel: 'low' | 'medium' | 'high' | 'critical';
}

// ---------------------------------------------------------------------------
// Transaction Policy Tier Config (4-tier classification)
// ---------------------------------------------------------------------------

export interface PolicyTierConfig {
  /** USD threshold below which trades are INSTANT (default: 100) */
  instantThreshold: number;
  /** USD threshold for NOTIFY tier (default: 1000) */
  notifyThreshold: number;
  /** USD threshold for DELAY tier (default: 10000) */
  delayThreshold: number;
  /** Delay seconds for DELAY tier (default: 300 = 5 min) */
  delaySeconds: number;
  /** Max slippage % allowed per tier */
  maxSlippageByTier: Record<PolicyTier, number>;
  /** Max gas-to-value ratio % per tier */
  maxGasRatioByTier: Record<PolicyTier, number>;
}

const DEFAULT_TIER_CONFIG: PolicyTierConfig = {
  instantThreshold: 100,
  notifyThreshold: 1000,
  delayThreshold: 10_000,
  delaySeconds: 300,
  maxSlippageByTier: {
    INSTANT: 1.0,
    NOTIFY: 0.5,
    DELAY: 0.3,
    APPROVAL: 0.2,
  },
  maxGasRatioByTier: {
    INSTANT: 10,
    NOTIFY: 5,
    DELAY: 3,
    APPROVAL: 2,
  },
};

// Policy rule schema
const PolicyRuleSchema = z.object({
  name: z.string(),
  condition: z.string(),
  action: z.enum(['allow', 'deny', 'require_approval']),
  requiredApprovals: z.array(z.string()).optional(),
  auditLevel: z.enum(['low', 'medium', 'high', 'critical'])
});

export interface PolicyRule {
  name: string;
  condition: string;
  action: 'allow' | 'deny' | 'require_approval';
  requiredApprovals?: string[];
  auditLevel: 'low' | 'medium' | 'high' | 'critical';
}

export class PolicyEngine {
  private audit: AuditTrail;
  private logger = new Logger('PolicyEngine');
  private policies: Map<string, PolicyRule[]> = new Map();
  private tierConfig: PolicyTierConfig;

  constructor(workspacePath: string, tierConfig?: Partial<PolicyTierConfig>) {
    this.audit = new AuditTrail(workspacePath);
    this.tierConfig = { ...DEFAULT_TIER_CONFIG, ...tierConfig };
  }

  async loadPolicies(policiesPath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const policyFiles = await fs.readdir(policiesPath);

      for (const file of policyFiles) {
        if (file.endsWith('.policy.json')) {
          const filePath = path.join(policiesPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const policy = JSON.parse(content);

          // Validate each rule individually, not the whole policy object
          const rules = policy.rules;
          if (!Array.isArray(rules)) {
            this.logger.error(`Invalid policy ${file}: missing or non-array 'rules' field`);
            continue;
          }

          let validRules: PolicyRule[] = [];
          let hasInvalid = false;
          for (const rule of rules) {
            const result = PolicyRuleSchema.safeParse(rule);
            if (!result.success) {
              this.logger.error(`Invalid rule in policy ${file}: ${result.error.message}`);
              hasInvalid = true;
            } else {
              validRules.push(result.data);
            }
          }

          if (validRules.length === 0) {
            this.logger.error(`Policy ${file} has no valid rules, skipping`);
            continue;
          }

          this.policies.set(policy.name, validRules);
          this.logger.info(`Loaded policy: ${policy.name} (${validRules.length} rules)`);
        }
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.logger.warn(`Policies directory not found: ${policiesPath} (no policies loaded)`);
        return;
      }
      this.logger.error('Failed to load policies', error);
      throw error;
    }
  }

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const reasons: string[] = [];
    let requiredApprovals: string[] = [];
    let maxAuditLevel: PolicyDecision['auditLevel'] = 'low';

    // Default: deny unknown high-risk actions
    if (!this.isKnownAction(input.requestedAction)) {
      if (this.isHighRiskAction(input.requestedAction)) {
        reasons.push('Unknown high-risk action denied by default');
        this.recordPolicyDecision(input, 'deny', reasons, maxAuditLevel);
        return {
          decision: 'deny',
          reasons,
          auditLevel: maxAuditLevel
        };
      }
      // Allow unknown low-risk actions
      this.recordPolicyDecision(input, 'allow', ['Unknown low-risk action allowed'], maxAuditLevel);
      return {
        decision: 'allow',
        reasons: ['Unknown low-risk action allowed'],
        auditLevel: maxAuditLevel
      };
    }

    // Evaluate all policies
    for (const [policyName, rules] of this.policies) {
      for (const rule of rules) {
        if (this.evaluateCondition(rule.condition, input)) {
          // Update max audit level
          if (this.compareAuditLevels(rule.auditLevel, maxAuditLevel) > 0) {
            maxAuditLevel = rule.auditLevel;
          }

          if (rule.action === 'deny') {
            reasons.push(`Denied by policy ${policyName}: ${rule.name}`);
            this.recordPolicyDecision(input, 'deny', reasons, maxAuditLevel);
            return {
              decision: 'deny',
              reasons,
              auditLevel: maxAuditLevel
            };
          }

          if (rule.action === 'require_approval') {
            if (rule.requiredApprovals) {
              requiredApprovals.push(...rule.requiredApprovals);
            }
            reasons.push(`Requires approval by policy ${policyName}: ${rule.name}`);
          }
        }
      }
    }

    // Final decision
    let decision: PolicyDecision['decision'] = 'allow';
    if (requiredApprovals.length > 0) {
      decision = 'require_approval';
    }

    if (reasons.length === 0) {
      reasons.push('No applicable policies, action allowed');
    }

    this.recordPolicyDecision(input, decision, reasons, maxAuditLevel);

    return {
      decision,
      reasons,
      requiredApprovals: requiredApprovals.length > 0 ? requiredApprovals : undefined,
      auditLevel: maxAuditLevel
    };
  }

  private evaluateCondition(condition: string, input: PolicyInput): boolean {
    const values: Record<string, unknown> = {
      actor: input.actor,
      actorType: input.actorType,
      requestedAction: input.requestedAction,
      mode: input.mode,
      riskLevel: input.artifact?.risk ?? 'low',
    };
    return this.evaluateConditionWithValues(condition, values);
  }

  /**
   * Enhanced condition evaluator supporting numerical thresholds.
   * Supports: ===, ==, !==, !=, >, <, >=, <= on numeric fields.
   */
  private evaluateConditionWithValues(condition: string, values: Record<string, unknown>): boolean {
    const evaluateComparison = (raw: string): boolean => {
      const clause = raw.trim().replace(/^\((.*)\)$/s, '$1').trim();

      // String equality: field === 'value' or field == 'value'
      const strMatch = clause.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(===|==|!==|!=)\s*(['"])(.*?)\3$/);
      if (strMatch) {
        const [, field, operator, , expected] = strMatch;
        if (!(field! in values)) return false;
        const equal = String(values[field!]) === expected;
        return operator === '===' || operator === '==' ? equal : !equal;
      }

      // Numerical comparison: field > 100, field <= 50, etc.
      const numMatch = clause.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|>|<)\s*(-?\d+\.?\d*)$/);
      if (numMatch) {
        const [, field, operator, expectedStr] = numMatch;
        if (!(field! in values)) return false;
        const actual = Number(values[field!]);
        const expected = Number(expectedStr);
        if (isNaN(actual) || isNaN(expected)) return false;
        switch (operator) {
          case '>': return actual > expected;
          case '<': return actual < expected;
          case '>=': return actual >= expected;
          case '<=': return actual <= expected;
          default: return false;
        }
      }

      // Unknown syntax fails closed
      return false;
    };

    return condition
      .split(/\s*\|\|\s*/)
      .some((group) => group.split(/\s*&&\s*/).every(evaluateComparison));
  }

  // ---------------------------------------------------------------------------
  // 4-Tier Transaction Policy
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a transaction against the 4-tier policy system.
   * Classifies trades into INSTANT / NOTIFY / DELAY / APPROVAL tiers
   * based on trade value, gas ratio, and configured thresholds.
   */
  async evaluateTransaction(tx: TransactionPolicyInput): Promise<TransactionPolicyEvaluation> {
    const tier = this.classifyTier(tx);
    const maxSlippage = this.tierConfig.maxSlippageByTier[tier];
    const maxGasRatio = this.tierConfig.maxGasRatioByTier[tier];

    // Check gas-to-value ratio
    if (tx.gasEstimate && tx.gasPrice && tx.tradeValueUsd) {
      const gasCostUsd = (Number(tx.gasEstimate) * Number(tx.gasPrice)) / 1e18;
      const gasRatio = (gasCostUsd / tx.tradeValueUsd) * 100;
      if (gasRatio > maxGasRatio) {
        return {
          tier,
          allowed: false,
          reason: `Gas ratio ${gasRatio.toFixed(1)}% exceeds max ${maxGasRatio}% for ${tier} tier`,
          maxSlippage,
          maxGasRatio,
        };
      }
    }

    // Check DEX-specific policies
    const dexDecision = await this.evaluateDexpolicies(tx);
    if (!dexDecision.allowed) {
      return {
        tier,
        allowed: false,
        reason: dexDecision.reason,
        maxSlippage,
        maxGasRatio,
      };
    }

    // Tier-based delays
    const delaySeconds = tier === 'DELAY' ? this.tierConfig.delaySeconds : undefined;

    return {
      tier,
      allowed: true,
      delaySeconds,
      maxSlippage,
      maxGasRatio,
    };
  }

  /**
   * Classify a transaction into a policy tier based on trade value.
   */
  private classifyTier(tx: TransactionPolicyInput): PolicyTier {
    const value = tx.tradeValueUsd ?? 0;
    if (value < this.tierConfig.instantThreshold) return 'INSTANT';
    if (value < this.tierConfig.notifyThreshold) return 'NOTIFY';
    if (value < this.tierConfig.delayThreshold) return 'DELAY';
    return 'APPROVAL';
  }

  /**
   * Evaluate DEX-specific policy rules.
   */
  private async evaluateDexpolicies(
    tx: TransactionPolicyInput,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Check token blacklist
    const dexRules = this.policies.get('dex') ?? [];
    for (const rule of dexRules) {
      if (rule.action === 'deny') {
        const values: Record<string, unknown> = {
          chainId: tx.chainId,
          tokenIn: tx.tokenIn,
          tokenOut: tx.tokenOut,
          amount: tx.amount,
          type: tx.type,
        };
        if (this.evaluateConditionWithValues(rule.condition, values)) {
          return { allowed: false, reason: `Denied by DEX policy: ${rule.name}` };
        }
      }
    }
    return { allowed: true };
  }

  private isKnownAction(action: string): boolean {
    const knownActions = [
      'read_memory',
      'write_memory',
      'run_research',
      'run_backtest',
      'run_paper',
      'run_shadow',
      'run_micro_live',
      'modify_risk_profile',
      'modify_trading_policy',
      'install_skill',
      'enable_shadow',
      'enable_micro_live',
      'enable_live',
      // DEX-specific actions
      'dex_swap',
      'dex_approve',
      'dex_bridge',
      'wallet_transfer',
      'wallet_batch_transfer',
    ];

    return knownActions.includes(action);
  }

  private isHighRiskAction(action: string): boolean {
    const highRiskActions = [
      'modify_risk_profile',
      'modify_trading_policy',
      'enable_shadow',
      'enable_micro_live',
      'enable_live',
      'run_micro_live',
      'run_live',
      // DEX high-risk actions
      'dex_swap',
      'dex_bridge',
      'wallet_transfer',
      'wallet_batch_transfer',
    ];

    return highRiskActions.includes(action);
  }

  private compareAuditLevels(a: PolicyDecision['auditLevel'], b: PolicyDecision['auditLevel']): number {
    const levels = ['low', 'medium', 'high', 'critical'];
    return levels.indexOf(a) - levels.indexOf(b);
  }

  private async recordPolicyDecision(
    input: PolicyInput,
    decision: PolicyDecision['decision'],
    reasons: string[],
    auditLevel: PolicyDecision['auditLevel']
  ) {
    await this.audit.record({
      type: 'policy',
      actor: input.actor,
      actorType: input.actorType,
      action: input.requestedAction,
      result: decision === 'allow' ? 'approved' : decision === 'deny' ? 'denied' : 'failed',
      details: {
        reasons,
        auditLevel,
        mode: input.mode
      },
      metadata: input
    });
  }
}
