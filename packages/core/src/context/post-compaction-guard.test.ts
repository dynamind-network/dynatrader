import { describe, expect, test } from "vitest";
import { PostCompactionGuard } from "./post-compaction-guard";

describe("PostCompactionGuard", () => {
  test("detects repeated tail messages", () => {
    const guard = new PostCompactionGuard();
    const result = guard.check([
      { role: "user", content: "A", timestamp: new Date() },
      { role: "assistant", content: "B", timestamp: new Date() },
      { role: "assistant", content: "B", timestamp: new Date() },
      { role: "assistant", content: "B", timestamp: new Date() },
    ]);

    expect(result.stuck).toBe(true);
    expect(result.pattern).toBe("B");
  });
});
