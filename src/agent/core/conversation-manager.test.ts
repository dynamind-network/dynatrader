import { describe, expect, test } from "vitest";
import { ConversationManager } from "./conversation-manager";

function message(role: "system" | "user" | "assistant" | "tool", content: string) {
  return { role, content, timestamp: new Date() };
}

describe("ConversationManager", () => {
  test("preserves the head and tail during compaction", () => {
    const manager = new ConversationManager({
      maxMessages: 100,
      maxContextTokens: 1_000_000,
      autoCompactThreshold: 0.8,
      keepHeadMessages: 2,
      keepRecentMessages: 2,
      maxMessageChars: 2_000,
    });

    manager.addMessage(message("system", "system root"));
    manager.addMessage(message("user", "first user intent"));
    manager.addMessage(message("assistant", "early assistant"));
    manager.addMessage(message("tool", "middle tool output"));
    manager.addMessage(message("user", "late user"));
    manager.addMessage(message("assistant", "latest assistant"));

    const summary = manager.compact();
    const messages = manager.getMessages();

    expect(summary).toContain("Compacted");
    expect(messages[0]?.content).toBe("system root");
    expect(messages[1]?.content).toBe("first user intent");
    expect(messages[messages.length - 2]?.content).toBe("late user");
    expect(messages[messages.length - 1]?.content).toBe("latest assistant");
    expect(messages.some((entry) => entry.content?.includes("[Conversation Summary]"))).toBe(true);
  });

  test("truncates oversized message content before it enters history", () => {
    const manager = new ConversationManager({
      maxMessages: 100,
      maxContextTokens: 1_000_000,
      autoCompactThreshold: 0.8,
      keepHeadMessages: 1,
      keepRecentMessages: 1,
      maxMessageChars: 100,
    });

    manager.addMessage(message("tool", "x".repeat(500)));
    const stored = manager.getMessages()[0]?.content ?? "";

    expect(stored.length).toBeLessThan(800);
    expect(stored).toContain("truncated");
  });

  test("compacts automatically before request generation when over budget", () => {
    const manager = new ConversationManager({
      maxMessages: 100,
      maxContextTokens: 50,
      autoCompactThreshold: 0.2,
      keepHeadMessages: 1,
      keepRecentMessages: 1,
      maxMessageChars: 2_000,
    });

    manager.addMessage(message("system", "system root"));
    manager.addMessage(message("user", "first user intent ".repeat(20)));
    manager.addMessage(message("assistant", "middle assistant ".repeat(20)));
    manager.addMessage(message("user", "late user"));
    manager.addMessage(message("assistant", "latest assistant"));

    const messages = manager.getMessagesForRequest();

    expect(messages.some((entry) => entry.content?.includes("[Conversation Summary]"))).toBe(true);
    expect(messages[0]?.content).toBe("system root");
    expect(messages[messages.length - 1]?.content).toBe("latest assistant");
  });
});
