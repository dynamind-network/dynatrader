import type { PermissionMode, PermissionDecision, PermissionConfig, RiskLevel } from './modes.js';
import type { RiskClassifier } from './classifier.js';
import type { ToolExecutionContext } from '../core/types.js';

export interface ToolMetadata {
  name: string;
  description?: string;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  readOnly?: boolean;
  mutatesFiles?: boolean;
  mutatesExternalState?: boolean;
  rateLimit?: {
    maxCalls: number;
    windowMs: number;
  };
}

export class PermissionEngine {
  private config: PermissionConfig;
  private classifier: RiskClassifier;
  private auditLog: AuditEntry[] = [];

  constructor(config: PermissionConfig, classifier: RiskClassifier) {
    this.config = config;
    this.classifier = classifier;
  }

  updateConfig(config: Partial<PermissionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  canExecute(
    tool: ToolMetadata,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): PermissionDecision {
    const override = this.config.toolOverrides?.[tool.name];
    if (override) {
      const decision = this.applyMode(override, tool, input, context);
      this.logDecision(tool.name, input, decision);
      return decision;
    }

    const mode = this.getEffectiveMode(context);
    const decision = this.applyMode(mode, tool, input, context);
    this.logDecision(tool.name, input, decision);
    return decision;
  }

  private getEffectiveMode(context: ToolExecutionContext): PermissionMode {
    if (context.isSubagent && this.config.defaultMode === 'default') {
      return 'auto';
    }
    return this.config.defaultMode;
  }

  private applyMode(
    mode: PermissionMode,
    tool: ToolMetadata,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): PermissionDecision {
    switch (mode) {
      case 'bypass':
        return { allowed: true, requiresApproval: false };

      case 'deny':
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Tool ${tool.name} is denied by permission mode`,
          riskLevel: 'critical',
        };

      case 'auto': {
        if (this.config.autoApproveTools?.includes(tool.name)) {
          return { allowed: true, requiresApproval: false };
        }

        if (tool.readOnly) {
          return { allowed: true, requiresApproval: false };
        }

        const assessment = this.classifier.classify(tool.name, input);
        const shouldPrompt = this.shouldPromptForRisk(assessment.level);

        return {
          allowed: !shouldPrompt,
          requiresApproval: shouldPrompt,
          reason: shouldPrompt
            ? `Tool ${tool.name} requires approval (${assessment.level} risk)`
            : undefined,
          riskLevel: assessment.level,
        };
      }

      case 'default':
      default: {
        const defaultAssessment = this.classifier.classify(tool.name, input);
        const defaultShouldPrompt = this.shouldPromptForRisk(defaultAssessment.level);

        return {
          allowed: !defaultShouldPrompt,
          requiresApproval: defaultShouldPrompt,
          reason: defaultShouldPrompt
            ? `Tool ${tool.name} requires approval (${defaultAssessment.level} risk)`
            : undefined,
          riskLevel: defaultAssessment.level,
        };
      }
    }
  }

  private shouldPromptForRisk(riskLevel: RiskLevel): boolean {
    const threshold = this.config.riskThresholds?.[riskLevel] ?? 'prompt';
    return threshold === 'prompt';
  }

  private logDecision(
    toolName: string,
    input: Record<string, unknown>,
    decision: PermissionDecision
  ): void {
    this.auditLog.push({
      timestamp: Date.now(),
      toolName,
      input,
      decision,
    });

    if (this.auditLog.length > 10000) {
      this.auditLog.shift();
    }
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  getAuditLogForTool(toolName: string): AuditEntry[] {
    return this.auditLog.filter((entry) => entry.toolName === toolName);
  }

  clearAuditLog(): void {
    this.auditLog = [];
  }
}

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  input: Record<string, unknown>;
  decision: PermissionDecision;
}

export function createPermissionEngine(
  config: PermissionConfig,
  classifier: RiskClassifier
): PermissionEngine {
  return new PermissionEngine(config, classifier);
}

