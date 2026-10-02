import type {
  ApprovalMode,
  ToolExecutionContext,
  RiskLevel,
  RiskAssessment,
} from "../core/types.js";
import { BaseTool } from "./base-tool.js";
import { classifyShellCommand } from './shell-command-policy.js';

const PROTECTED_FILE_PATTERNS = [
  /\.env(\.|$)/,
  /\.env\.local$/,
  /\.env\.development$/,
  /\.env\.production$/,
  /settings\.json$/,
  /mcp\.json$/,
  /\.dynamind\/.*\.json$/,
  /\.git\/config$/,
  /\.ssh\/.*$/,
  /\.npmrc$/,
  /\.pki\/.*$/,
  /credentials$/,
  /\.aws\/credentials$/,
  /\.dynamind\/api-keys\.json$/,
  // CRITICAL: Expanded patterns for common credential locations
  /\/etc\/shadow$/,
  /\/etc\/passwd$/,
  /\.gnupg\/.*$/,
  /\.kube\/config$/,
  /\.docker\/config\.json$/,
  /\.config\/gcloud\/.*$/,
  /\.azure\/.*$/,
  /id_rsa$/,
  /id_ed25519$/,
  /\.netrc$/,
  /\.pgpass$/,
  /\.htpasswd$/,
  /\.vault.*$/,
  /\.secret.*$/,
  /passwords.*$/,
  /\.ssh\/id_/,
  /\/proc\/.*$/,
  /\.boto$/,
  /service-account.*\.json$/,
  /credentials\.json$/,
];

export interface ToolApprovalDecision {
  requiresApproval: boolean;
  reason: string | null;
  riskLevel: RiskLevel;
}

/**
 * CRITICAL: Normalize file path to prevent path traversal attacks.
 * Resolves .., . and collapses multiple slashes.
 */
function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")           // Normalize Windows backslashes
    .replace(/\/+/g, "/")          // Collapse multiple slashes
    .replace(/\/\.\//g, "/")       // Remove single-dot segments
    .replace(/\/[^/]*\/\.\.\//g, "/"); // Remove parent traversals
}

/**
 * CRITICAL: Maximum depth for recursive input scanning to prevent stack overflow
 * on deeply nested or circular input objects.
 */
const MAX_SCAN_DEPTH = 8;

export function isProtectedFile(path: string): boolean {
  // CRITICAL: Normalize the path before checking to prevent traversal bypass
  const normalizedPath = normalizePath(path).toLowerCase();
  return PROTECTED_FILE_PATTERNS.some((pattern) =>
    pattern.test(normalizedPath),
  );
}

/**
 * CRITICAL: Recursively scan input values for protected file access.
 * Depth-limited to prevent stack overflow on malicious inputs.
 */
function scanInputForProtectedFiles(
  obj: Record<string, unknown>,
  depth = 0
): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;

  for (const [, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > 0 && value.length < 2048) {
      if (isProtectedFile(value)) return true;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (scanInputForProtectedFiles(value as Record<string, unknown>, depth + 1)) {
        return true;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0 && item.length < 2048) {
          if (isProtectedFile(item)) return true;
        } else if (item && typeof item === 'object') {
          if (scanInputForProtectedFiles(item as Record<string, unknown>, depth + 1)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function assessRisk(
  tool: BaseTool,
  input: Record<string, unknown>,
): RiskAssessment {
  const reasons: string[] = [];
  const affectedResources: string[] = [];

  const toolRiskLevel = tool.riskLevel || "low";

  if (tool.mutatesExternalState) {
    reasons.push("Tool modifies external state (wallet, network, etc.)");
    affectedResources.push("wallet", "network");
  }

  if (tool.isDestructive) {
    reasons.push("Tool performs destructive action");
  }

  if (tool.requiresApproval) {
    reasons.push("Tool requires explicit approval");
  }

  // CRITICAL: Check ALL string values in input against protected file patterns
  // using recursive depth-limited scan
  if (scanInputForProtectedFiles(input)) {
    reasons.push("Tool accesses protected file");
    affectedResources.push("protected-config");
  }

  if (tool.mutatesExternalState) {
    return { level: "high", reasons, affectedResources };
  }

  if (tool.isDestructive || reasons.length > 0) {
    return { level: "medium", reasons, affectedResources };
  }

  if (toolRiskLevel === "high") {
    return {
      level: "high",
      reasons: ["Tool marked as high risk"],
      affectedResources,
    };
  }

  if (toolRiskLevel === "medium") {
    return {
      level: "medium",
      reasons: ["Tool marked as medium risk"],
      affectedResources,
    };
  }

  return { level: "low", reasons: [], affectedResources: [] };
}

export class ToolExecutionPolicy {
  async evaluateApproval(
    tool: BaseTool,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
    approvalMode: ApprovalMode,
  ): Promise<ToolApprovalDecision> {
    const riskAssessment = assessRisk(tool, input);
    if (tool.name === 'shell' && typeof input.command === 'string') {
      const shellDecision = classifyShellCommand(input.command);
      if (shellDecision.decision === 'block') return { requiresApproval: false, reason: `Command blocked by safety policy: ${shellDecision.reason}`, riskLevel: 'high' };
      if (shellDecision.decision === 'approval') return { requiresApproval: true, reason: shellDecision.reason, riskLevel: 'high' };
      if (approvalMode === 'yolo') return { requiresApproval: false, reason: null, riskLevel: riskAssessment.level };
    }

    if (approvalMode === "yolo") {
      // CRITICAL: Even in YOLO mode, require approval for external state mutations
      // (wallet, blockchain, network write operations) to prevent fund drainage
      if (tool.mutatesExternalState) {
        return {
          requiresApproval: true,
          reason: "Tool mutates external state (wallet, blockchain) — requires approval even in YOLO mode.",
          riskLevel: "high",
        };
      }
      return {
        requiresApproval: false,
        reason: null,
        riskLevel: riskAssessment.level,
      };
    }

    const explicitReason = await tool.shouldConfirmExecute(input, context);
    if (explicitReason) {
      return {
        requiresApproval: true,
        reason: explicitReason,
        riskLevel: "high",
      };
    }

    if (
      !tool.requiresApproval &&
      !tool.isDestructive &&
      riskAssessment.level === "low"
    ) {
      return { requiresApproval: false, reason: null, riskLevel: "low" };
    }

    if (approvalMode === "auto_edit") {
      if (tool.readOnly && !tool.mutatesExternalState) {
        return { requiresApproval: false, reason: null, riskLevel: "low" };
      }

      if (
        tool.mutatesFiles &&
        !tool.mutatesExternalState &&
        !tool.isDestructive
      ) {
        // CRITICAL: In auto_edit mode, still require approval for protected files
        // Use recursive scan to catch all input values including nested ones
        if (scanInputForProtectedFiles(input)) {
          return {
            requiresApproval: true,
            reason: "Tool writes to protected file — requires approval even in auto_edit mode.",
            riskLevel: "medium",
          };
        }
        return { requiresApproval: false, reason: null, riskLevel: "low" };
      }
    }

    if (tool.mutatesExternalState) {
      return {
        requiresApproval: true,
        reason: "Tool may mutate wallet, network, or other external state.",
        riskLevel: "high",
      };
    }

    if (tool.mutatesFiles || tool.isDestructive || tool.requiresApproval) {
      return {
        requiresApproval: true,
        reason: "Tool may modify files or perform a destructive action.",
        riskLevel: riskAssessment.level,
      };
    }

    return {
      requiresApproval: false,
      reason: null,
      riskLevel: riskAssessment.level,
    };
  }

  canRunInParallel(tool: BaseTool): boolean {
    return (
      tool.canRunInParallel &&
      tool.readOnly &&
      !tool.mutatesFiles &&
      !tool.mutatesExternalState &&
      !tool.requiresApproval
    );
  }
}

