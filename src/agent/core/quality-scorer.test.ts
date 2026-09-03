import { describe, expect, test } from "vitest";
import { QualityScorer } from "./quality-scorer";

const scorer = new QualityScorer();

describe("QualityScorer", () => {
  test("scores are always between 0 and 1 inclusive", () => {
    const empty = scorer.score("", []);
    expect(empty.overall).toBeGreaterThanOrEqual(0);
    expect(empty.overall).toBeLessThanOrEqual(1);
    expect(empty.coherence).toBeGreaterThanOrEqual(0);
    expect(empty.coherence).toBeLessThanOrEqual(1);
    expect(empty.toolUsage).toBeGreaterThanOrEqual(0);
    expect(empty.toolUsage).toBeLessThanOrEqual(1);
    expect(empty.actionability).toBeGreaterThanOrEqual(0);
    expect(empty.actionability).toBeLessThanOrEqual(1);
    expect(empty.conciseness).toBeGreaterThanOrEqual(0);
    expect(empty.conciseness).toBeLessThanOrEqual(1);

    const long = scorer.score("a".repeat(5000), []);
    expect(long.overall).toBeGreaterThanOrEqual(0);
    expect(long.overall).toBeLessThanOrEqual(1);

    // Very high tool usage
    const tools = Array.from({ length: 10 }, (_, i) => ({
      tool: `tool${i % 3}`,
      args: { key: `value${i}` },
    }));
    const withTools = scorer.score("done executing analysis", tools);
    expect(withTools.overall).toBeGreaterThanOrEqual(0);
    expect(withTools.overall).toBeLessThanOrEqual(1);
  });

  test("responses with tool calls score higher overall than plain text responses", () => {
    const text = "I am analyzing the current market conditions to determine the best entry point for this trade.";
    const plain = scorer.score(text, []);
    const withTools = scorer.score(text, [
      { tool: "analyze_market", args: { symbol: "BTC/USD" } },
    ]);

    expect(withTools.overall).toBeGreaterThan(plain.overall);
  });

  test("repetitive verbose text gets lower actionability than concise text", () => {
    const verbose = scorer.score(
      "um, well you know, I think we could maybe sort of look at the price and uh perhaps consider " +
        "the value and then kind of analyze the result and see what the percentage is and then maybe " +
        "after that we could sort of look at the total and um I'm not sure but we could consider the " +
        "status of things and then perhaps evaluate further",
      [],
    );

    const concise = scorer.score(
      "Executing market analysis. Price: $45,230. Result: bullish. Value: above support. Done.",
      [],
    );

    expect(concise.actionability).toBeGreaterThan(verbose.actionability);
  });

  test("diverse tool usage gets higher toolUsage score than single-tool repetition", () => {
    const single = scorer.score("analyzing the data", [
      { tool: "read_file", args: { path: "/data.csv" } },
      { tool: "read_file", args: { path: "/data2.csv" } },
      { tool: "read_file", args: { path: "/data3.csv" } },
      { tool: "read_file", args: { path: "/data4.csv" } },
    ]);

    const diverse = scorer.score("fetching and analyzing data", [
      { tool: "fetch_price", args: { symbol: "BTC" } },
      { tool: "analyze_trend", args: { period: "1h" } },
      { tool: "calculate_rsi", args: { periods: 14 } },
    ]);

    expect(diverse.toolUsage).toBeGreaterThan(single.toolUsage);
  });

  test("coherence scoring: well-structured text scores higher than unstructured", () => {
    const unstructured = scorer.score(
      "so i checked the price and it was going up then it went down and i'm not sure what to do " +
        "maybe we should wait and see what happens next because the market is volatile",
      [],
    );

    const structured = scorer.score(
      "## Market Analysis\n\n" +
        "Price action shows strong support at $45,000.\n\n" +
        "Key observations:\n" +
        "- Resistance at $46,200\n" +
        "- Volume increasing\n" +
        "- RSI at 62\n\n" +
        "Therefore, I recommend entering.",
      [],
    );

    expect(structured.coherence).toBeGreaterThan(unstructured.coherence);
  });

  test("conciseness scoring: very short gets penalized, sweet spot gets bonus", () => {
    const tooShort = scorer.score("Done.", []);
    const sweetSpot = scorer.score(
      "Executing market analysis. The current price of BTC is $45,230 with strong " +
        "support at the $44,900 level. Volume is increasing which confirms the upward " +
        "momentum. Therefore, I recommend entering a long position.",
      [],
    );
    const verbose = scorer.score(
      Array.from({ length: 50 }, () =>
        "This is a very long and repetitive text that goes on and on and on without any real " +
          "substance or meaningful content whatsoever. It just keeps going forever and ever."
      ).join(" "),
      [],
    );

    expect(sweetSpot.conciseness).toBeGreaterThan(tooShort.conciseness);
    expect(sweetSpot.conciseness).toBeGreaterThan(verbose.conciseness);
  });

  test("actionability: responses with action words and tool calls get higher scores", () => {
    const passive = scorer.score(
      "I'm not sure if the price is going up or down. Perhaps we could look at the market " +
        "conditions. It might be a good time to trade but I don't know.",
      [],
    );

    const actionable = scorer.score(
      "Executing buy order now. Analyzing the price action. Result: strong buy signal " +
        "confirmed. Total position value calculated. Done.",
      [
        { tool: "place_order", args: { side: "buy", amount: 0.1 } },
        { tool: "calculate_risk", args: { stopLoss: 44000 } },
      ],
    );

    expect(actionable.actionability).toBeGreaterThan(passive.actionability);
  });

  test("all score components are returned with details", () => {
    const result = scorer.score("Analyzing the market data. Result: positive.", [
      { tool: "fetch_data", args: { source: "binance" } },
    ]);

    expect(result).toHaveProperty("overall");
    expect(result).toHaveProperty("coherence");
    expect(result).toHaveProperty("toolUsage");
    expect(result).toHaveProperty("actionability");
    expect(result).toHaveProperty("conciseness");
    expect(result).toHaveProperty("details");
    expect(Array.isArray(result.details)).toBe(true);
    expect(result.details.length).toBeGreaterThan(0);
  });

  test("hedging language reduces coherence", () => {
    const hedging = scorer.score(
      "I'm not sure about this trade. Maybe we should wait. Perhaps the market will recover. " +
        "I don't know if this is the right time. I think the price might go up, but I could be wrong.",
      [],
    );

    const direct = scorer.score(
      "The analysis shows a clear buy signal. Price is above support. Volume confirms the breakout. " +
        "Therefore, I am executing the trade now.",
      [],
    );

    expect(hedging.coherence).toBeLessThan(direct.coherence);
  });

  test("ambivalent language without resolution reduces coherence", () => {
    const ambivalent = scorer.score(
      "The price is going up, however the volume is low. But the trend is strong, although " +
        "resistance is near. I'm conflicted about what to do.",
      [],
    );

    const resolved = scorer.score(
      "The price is going up, however the volume is low. But the trend is strong, although " +
        "resistance is near. Therefore, I will wait for a clearer signal. Clearly the best " +
        "approach is to be patient. Definitely worth waiting.",
      [],
    );

    expect(ambivalent.coherence).toBeLessThan(resolved.coherence);
  });

  test("filler language reduces actionability", () => {
    const filler = scorer.score(
      "Um, well you know, the price is sort of going up. Kind of looks like we could enter " +
        "a position, uh, maybe?",
      [],
    );

    const clean = scorer.score(
      "The price is breaking resistance at $45,200. Volume confirms the breakout. " +
        "Executing buy order now.",
      [],
    );

    expect(clean.actionability).toBeGreaterThan(filler.actionability);
  });

  test("no tools results in lower toolUsage than with tools", () => {
    const noTools = scorer.score("I think the price is going up.", []);
    const hasTools = scorer.score("Analyzing the price action.", [
      { tool: "get_price", args: { symbol: "BTC" } },
    ]);

    expect(hasTools.toolUsage).toBeGreaterThan(noTools.toolUsage);
  });

  test("excessive single-tool repetition gets penalized", () => {
    const repeated = scorer.score("reading files repeatedly", [
      { tool: "read_file", args: { path: "/a" } },
      { tool: "read_file", args: { path: "/b" } },
      { tool: "read_file", args: { path: "/c" } },
      { tool: "read_file", args: { path: "/d" } },
      { tool: "read_file", args: { path: "/e" } },
    ]);

    const moderate = scorer.score("diverse tool usage", [
      { tool: "fetch", args: {} },
      { tool: "analyze", args: {} },
      { tool: "report", args: {} },
    ]);

    expect(moderate.toolUsage).toBeGreaterThan(repeated.toolUsage);
  });

  test("very long text gets penalized in conciseness", () => {
    const longText = Array.from({ length: 60 }, (_, i) =>
      `This is paragraph number ${i + 1} of a very long response that goes into extensive detail ` +
      "about market conditions, technical analysis, fundamental factors, and trading strategies. " +
      "It repeats itself multiple times and could be much more concise."
    ).join("\n\n");

    const result = scorer.score(longText, []);
    expect(result.conciseness).toBeLessThan(0.5);
  });

  test("very short text gets penalized in conciseness", () => {
    const result = scorer.score("Done.", []);
    expect(result.conciseness).toBe(0.3); // starts at 0.5, -0.2 for <10 words
  });
});
