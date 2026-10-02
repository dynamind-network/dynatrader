export type PermissionMode = "default" | "auto" | "bypass" | "deny";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  affectedResources: string[];
}

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  riskLevel?: RiskLevel;
}

export interface PermissionConfig {
  defaultMode: PermissionMode;
  autoApproveTools?: string[];
  riskThresholds?: {
    low: "always" | "prompt" | "deny";
    medium: "always" | "prompt" | "deny";
    high: "always" | "prompt" | "deny";
    critical: "always" | "prompt" | "deny";
  };
  toolOverrides?: Record<string, PermissionMode>;
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  defaultMode: "default",
  autoApproveTools: [],
  riskThresholds: {
    low: "always",
    medium: "prompt",
    high: "prompt",
    critical: "deny",
  },
  toolOverrides: {},
};

export function getRiskLevelFromTool(tool: {
  riskLevel?: RiskLevel;
  isDestructive?: boolean;
  mutatesExternalState?: boolean;
}): RiskLevel {
  if (tool.riskLevel) {
    return tool.riskLevel;
  }

  if (tool.isDestructive) {
    return "high";
  }

  if (tool.mutatesExternalState) {
    return "medium";
  }

  return "low";
}

export function shouldPromptForRisk(
  riskLevel: RiskLevel,
  config: PermissionConfig,
): boolean {
  const threshold = config.riskThresholds?.[riskLevel] ?? "prompt";
  return threshold === "prompt";
}

