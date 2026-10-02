import { describe, expect, it } from "vitest";
import { ToolResultCompressor } from "./tool-result-compressor";

describe("ToolResultCompressor", () => {
  it("collapses repeated noisy lines and points to the retrievable original", async () => {
    const repeated = "DEBUG polling provider; no change";
    const compressor = new ToolResultCompressor({ useLlmSummarization: false });
    const [result] = await compressor.compressResults([{
      tool: "web_fetch",
      args: { url: "https://example.test" },
      id: "call-noisy-17",
      result: { success: true, data: Array(150).fill(repeated).join("\n"), durationMs: 30, truncated: false },
    }]);

    expect(result.preserved).toBe(false);
    expect(result.compressedContent).toContain("repeated identical line");
    expect(result.fullResultAvailable).toBe(true);
    expect(compressor.buildPromptMessages([result])[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call-noisy-17",
    });
    expect(compressor.buildPromptMessages([result])[0].content).toContain("get_tool_result");
  });

  it("keeps failure details and structured evidence/provenance when crushing large results", async () => {
    const compressor = new ToolResultCompressor({ useLlmSummarization: false });
    const [result] = await compressor.compressResults([{
      tool: "market_data",
      args: { action: "ohlcv", symbol: "BTC/USDT" },
      id: "market-call-42",
      result: {
        success: false,
        error: "venue request returned HTTP 451",
        durationMs: 1000,
        truncated: false,
        data: {
          source: "binance-testnet",
          venue: "binance",
          asOf: "2026-10-01T10:00:00Z",
          evidence: { statusCode: 451, detail: "restricted location" },
          candles: Array.from({ length: 1200 }, (_, i) => ({ timestamp: i, close: 100 + i })),
        },
      },
    }]);

    expect(result.compressedContent).toContain("Tool failed: venue request returned HTTP 451");
    expect(result.compressedContent).toContain('"venue":"binance"');
    expect(result.compressedContent).toContain('"source":"binance-testnet"');
    expect(result.compressedContent).toContain('"statusCode":451');
    expect(result.toolCallId).toBe("market-call-42");
    expect(compressor.buildPromptMessages([result])[0].tool_call_id).toBe("market-call-42");
  });
});
