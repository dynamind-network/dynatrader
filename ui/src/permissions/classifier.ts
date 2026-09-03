import type { RiskLevel, RiskAssessment } from "./modes.js";

export interface RiskClassifier {
  classify(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): RiskAssessment;
}

export class RuleBasedClassifier implements RiskClassifier {
  private rules: Array<{
    pattern: RegExp;
    riskLevel: RiskLevel;
    reason: string;
  }> = [
    {
      pattern: /^(shell|exec|bash|powershell)/i,
      riskLevel: "high",
      reason: "Executes arbitrary shell commands",
    },
    {
      pattern: /^(write)/i,
      riskLevel: "high",
      reason: "Creates or overwrites files",
    },
    {
      pattern: /^(edit)/i,
      riskLevel: "medium",
      reason: "Modifies existing files",
    },
    {
      pattern: /^(delete_file|rm|del)/i,
      riskLevel: "critical",
      reason: "Deletes files",
    },
    {
      pattern: /^(place_order|trade|submit_order)/i,
      riskLevel: "high",
      reason: "Places live trades",
    },
    {
      pattern: /^(transfer|withdraw|send)/i,
      riskLevel: "critical",
      reason: "Transfers funds",
    },
    {
      pattern: /^(get_ticker|get_price|fetch_market)/i,
      riskLevel: "low",
      reason: "Reads market data",
    },
    {
      pattern: /^(question|ask_question)/i,
      riskLevel: "low",
      reason: "Prompts the user for a choice",
    },
    {
      pattern: /^(get_balance|get_positions|portfolio)/i,
      riskLevel: "low",
      reason: "Reads account data",
    },
    {
      pattern: /^(read|glob|grep|search)/i,
      riskLevel: "low",
      reason: "Reads files",
    },
  ];

  classify(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): RiskAssessment {
    for (const rule of this.rules) {
      if (rule.pattern.test(toolName)) {
        return {
          level: rule.riskLevel,
          reasons: [rule.reason],
          affectedResources: this.extractResources(toolInput),
        };
      }
    }

    return {
      level: "medium",
      reasons: ["No specific rule matched, defaulting to medium risk"],
      affectedResources: [],
    };
  }

  private extractResources(input: Record<string, unknown>): string[] {
    const resources: string[] = [];

    if (typeof input.path === "string") {
      resources.push(input.path);
    }

    if (typeof input.filePath === "string") {
      resources.push(input.filePath);
    }

    if (typeof input.symbol === "string") {
      resources.push(input.symbol);
    }

    return resources;
  }
}

export function createClassifier(): RiskClassifier {
  return new RuleBasedClassifier();
}
