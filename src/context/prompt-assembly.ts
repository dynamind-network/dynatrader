import type { AgentTurnContext } from "@dyna/contracts";

export type PromptTierName = "stable" | "context" | "volatile";

export interface PromptTier {
  name: PromptTierName;
  content: string;
  tokens: number;
  prunable: boolean;
}

export interface PromptAssemblyInput {
  stable: string[];
  context: string[];
  volatile: string[];
  currentContext: AgentTurnContext;
}

export interface PromptAssemblyResult {
  systemPrompt: string;
  tiers: PromptTier[];
  tokenCount: number;
}

function countTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function normalize(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

export class PromptAssembly {
  assemble(input: PromptAssemblyInput): PromptAssemblyResult {
    const tiers: PromptTier[] = [
      {
        name: "stable" as const,
        content: normalize(input.stable),
        tokens: countTokens(normalize(input.stable)),
        prunable: false,
      },
      {
        name: "context" as const,
        content: normalize(input.context),
        tokens: countTokens(normalize(input.context)),
        prunable: false,
      },
      {
        name: "volatile" as const,
        content: normalize(input.volatile),
        tokens: countTokens(normalize(input.volatile)),
        prunable: true,
      },
    ].filter((tier): tier is PromptTier => tier.content.length > 0);

    const systemPrompt = [
      `Current time: ${input.currentContext.now.toISOString()}`,
      `Mode: ${input.currentContext.mode}`,
      `Account: ${input.currentContext.accountId}`,
      `Portfolio: ${input.currentContext.portfolioId}`,
      `Session: ${input.currentContext.sessionId ?? 'default'}`,
      ...tiers.map((tier) => `=== ${tier.name.toUpperCase()} ===\n${tier.content}`),
    ].join("\n\n");

    return {
      systemPrompt,
      tiers,
      tokenCount: tiers.reduce((sum, tier) => sum + tier.tokens, 0),
    };
  }
}

export const promptAssembly = new PromptAssembly();
