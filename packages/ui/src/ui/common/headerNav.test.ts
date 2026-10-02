import { describe, expect, it } from "vitest";
import { buildHeaderNavLayout } from "./header-nav-layout.js";

describe("buildHeaderNavLayout", () => {
  it("shows the full nav on wide terminals", () => {
    const layout = buildHeaderNavLayout(120, "chat");
    expect(layout.text.length).toBeLessThanOrEqual(120);
    expect(layout.text).toContain("Chat");
    expect(layout.text).toContain("Markets");
    expect(layout.text).toContain("Portfolio");
    expect(layout.text).toContain("Search");
    expect(layout.text).toContain("| Esc:Chat");
  });

  it("compresses labels at medium widths without overflow", () => {
    const layout = buildHeaderNavLayout(80, "chat");
    expect(layout.text.length).toBeLessThanOrEqual(80);
    expect(layout.text).toContain("Chat");
    expect(layout.text).toContain("Mkt");
    expect(layout.text).toContain("Port");
    expect(layout.text).not.toContain("Markets");
  });

  it("keeps the active screen visible at narrow widths", () => {
    const layout = buildHeaderNavLayout(60, "analysis");
    expect(layout.text.length).toBeLessThanOrEqual(60);
    expect(layout.text).toContain("Analyze");
    expect(layout.text).toContain("| Esc:Chat");
  });

  it("falls back to app name plus active screen at very narrow widths", () => {
    const layout = buildHeaderNavLayout(40, "chat");
    expect(layout.text.length).toBeLessThanOrEqual(40);
    expect(layout.text).toContain("Dynamind v1.0.0 | Chat");
    expect(layout.text).not.toContain("Markets");
    expect(layout.text).not.toContain("Help ");
  });

  it("never exceeds the provided width in the previous overflow band", () => {
    const layout = buildHeaderNavLayout(78, "chat");
    expect(layout.text.length).toBeLessThanOrEqual(78);
  });
});

