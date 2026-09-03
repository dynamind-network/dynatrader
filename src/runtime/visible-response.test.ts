import { describe, it, expect } from "vitest";
import { requireVisibleResponse } from "./visible-response";

describe("requireVisibleResponse", () => {
  it("returns visible content when present", () => {
    expect(requireVisibleResponse("hello", "fallback", "test")).toBe("hello");
  });

  it("rejects reasoning-only output when visible text is missing", () => {
    expect(() => requireVisibleResponse("", "working through it", "test")).toThrow("test produced no visible output.");
  });

  it("treats thinking visibility as diagnostic only", () => {
    expect(() => requireVisibleResponse("", "working through it", "test", true)).toThrow("test produced no visible output.");
    expect(() => requireVisibleResponse("", "working through it", "test", false)).toThrow("test produced no visible output.");
  });

  it("rejects boilerplate reasoning markers", () => {
    expect(() => requireVisibleResponse("", "Thinking Process:", "test")).toThrow("test produced no visible output.");
  });

  it("throws when both outputs are empty", () => {
    expect(() => requireVisibleResponse("   ", "  ", "test")).toThrow("test produced no visible output.");
  });
});
