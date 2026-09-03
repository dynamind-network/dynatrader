import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { Box, Text } from "ink";
import { LiveTickerStrip } from "./LiveTickerStrip.js";
import { useLiveTicker } from "./LiveTicker.js";

vi.mock("./LiveTicker.js", async () => {
  const actual = await vi.importActual<typeof import("./LiveTicker.js")>(
    "./LiveTicker.js"
  );
  return {
    ...actual,
    useLiveTicker: vi.fn(() => ({ tickers: new Map(), isConnected: false })),
  };
});

/** Extract text content from a React element tree */
function getTextContent(element: any): string {
  if (typeof element === "string" || typeof element === "number") {
    return String(element);
  }
  if (!element || typeof element !== "object") return "";
  const children = element.props?.children;
  if (Array.isArray(children)) {
    return children.map(getTextContent).join("");
  }
  return getTextContent(children);
}

/** Recursively find all elements matching a given type in a React element tree */
function findByType(element: any, type: any): any[] {
  const results: any[] = [];
  if (!element || typeof element !== "object") return results;
  if (element.type === type) results.push(element);
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      results.push(...findByType(child, type));
    }
  } else if (children && typeof children === "object") {
    results.push(...findByType(children, type));
  }
  return results;
}

describe("LiveTickerStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockTickers = () =>
    new Map([
      [
        "BTC",
        {
          symbol: "BTC",
          price: 67420,
          change24h: 2.4,
          volume24h: 1000000,
          funding: 0.01,
          lastUpdate: new Date(),
        },
      ],
      [
        "ETH",
        {
          symbol: "ETH",
          price: 3420,
          change24h: -1.2,
          volume24h: 500000,
          funding: 0.02,
          lastUpdate: new Date(),
        },
      ],
      [
        "SOL",
        {
          symbol: "SOL",
          price: 142,
          change24h: 5.6,
          volume24h: 200000,
          funding: -0.01,
          lastUpdate: new Date(),
        },
      ],
    ]);

  it("renders price data correctly", () => {
    (useLiveTicker as any).mockReturnValue({
      tickers: createMockTickers(),
      isConnected: true,
    });

    const result = LiveTickerStrip({ width: 120 });

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join("");
    expect(textContents).toContain("BTC");
    expect(textContents).toContain("$67,420");
    expect(textContents).toContain("ETH");
    expect(textContents).toContain("$3,420");
    expect(textContents).toContain("SOL");
    expect(textContents).toContain("$142.00");
  });

  it("shows loading state when not connected and no data", () => {
    (useLiveTicker as any).mockReturnValue({
      tickers: new Map(),
      isConnected: false,
    });

    const result = LiveTickerStrip({ width: 120 });

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join("");
    expect(textContents).toContain("...");
  });

  it("shows green for positive changes and red for negative", () => {
    (useLiveTicker as any).mockReturnValue({
      tickers: createMockTickers(),
      isConnected: true,
    });

    const result = LiveTickerStrip({ width: 120 });

    const texts = findByType(result, Text);
    const btcChange = texts.find((t) =>
      getTextContent(t).includes("(+2.4%)")
    );
    const ethChange = texts.find((t) =>
      getTextContent(t).includes("(-1.2%)")
    );

    expect(btcChange?.props.color).toBe("green");
    expect(ethChange?.props.color).toBe("red");
  });

  it("handles missing data gracefully", () => {
    (useLiveTicker as any).mockReturnValue({
      tickers: new Map([
        [
          "BTC",
          {
            symbol: "BTC",
            price: 67420,
            change24h: 2.4,
            volume24h: 1000000,
            funding: 0.01,
            lastUpdate: new Date(),
          },
        ],
      ]),
      isConnected: true,
    });

    const result = LiveTickerStrip({ width: 120 });

    const texts = findByType(result, Text);
    const textContents = texts.map(getTextContent).join("");
    expect(textContents).toContain("BTC");
    expect(textContents).toContain("$67,420");
    expect(textContents).toContain("ETH");
    expect(textContents).toContain("--");
    expect(textContents).toContain("SOL");
  });

  it("returns null when width is less than 80", () => {
    (useLiveTicker as any).mockReturnValue({
      tickers: createMockTickers(),
      isConnected: true,
    });

    const result = LiveTickerStrip({ width: 60 });
    expect(result).toBeNull();
  });
});
