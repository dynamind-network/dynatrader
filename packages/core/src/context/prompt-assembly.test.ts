import { describe, expect, test } from "vitest";
import { promptAssembly } from "./prompt-assembly";

describe("PromptAssembly", () => {
  test("assembles stable, context, and volatile tiers", () => {
    const result = promptAssembly.assemble({
      stable: ["workspace rules"],
      context: ["recent conversation summary"],
      volatile: ["tool output"],
      currentContext: {
        now: new Date("2026-07-12T00:00:00.000Z"),
        mode: "paper",
        accountId: "acct-1",
        portfolioId: "port-1",
        correlationId: "corr-1",
      },
    });

    expect(result.systemPrompt).toContain("=== STABLE ===");
    expect(result.systemPrompt).toContain("=== CONTEXT ===");
    expect(result.systemPrompt).toContain("=== VOLATILE ===");
    expect(result.tokenCount).toBeGreaterThan(0);
  });
});
