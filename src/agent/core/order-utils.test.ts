import { describe, expect, it } from "vitest";
import type { SkillManifest, AgentTurnContext } from "@dyna/contracts";
import { calculateOrderSize, generateOrderIntents } from "./order-utils";

function makeStrategy(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: "strategy-1",
    venue: "custom-venue",
    symbol: "ETH/USDT",
    entry: {},
    exits: {},
    sizing: { amount: 1 },
    risk: {
      maxPositionNotional: 1000,
      maxDailyLoss: 100,
      maxOpenOrders: 3,
    },
    executionMode: "paper",
    ...overrides,
  };
}

const context: AgentTurnContext = {
  now: new Date("2026-07-11T00:00:00.000Z"),
  mode: "paper",
  accountId: "acct-1",
  portfolioId: "portfolio-1",
  correlationId: "corr-1",
};

describe("order-utils", () => {
  it("uses only explicit exit values and does not invent stop or take profit orders", () => {
    const strategy = makeStrategy({
      exits: {},
      sizing: { amount: 2 },
    });

    const intents = generateOrderIntents(strategy, context);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      venue: "custom-venue",
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      quantity: 2,
    });
  });

  it("requires explicit amount sizing", () => {
    expect(() =>
      calculateOrderSize(
        makeStrategy({
          sizing: { percentage: 5 },
        }),
      ),
    ).toThrow("Percentage sizing must be resolved upstream into an explicit amount");
  });
});
